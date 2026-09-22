import "server-only";

import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { MAX_FOLDER_DEPTH, MEDIA_PREFIX, folderSegments, isMediaKey } from "@/lib/mediaPaths";

/**
 * Everything this project writes lives under one prefix, which is what keeps
 * the media library from listing another site's uploads.
 *
 * Re-exported rather than declared: it is defined once in src/lib/mediaPaths.ts,
 * which the browser can import too. Every server module that already says
 * `import { MEDIA_PREFIX } from "@/lib/server/s3"` keeps working.
 */
export { MEDIA_PREFIX };

/**
 * Where a registration attachment goes. A different prefix, deliberately.
 *
 * Everything under MEDIA_PREFIX is a logo or a photograph meant to be on a web
 * page, and is served straight from the bucket with a public, immutable cache
 * header. These are licence scans, indemnity forms and passport photographs
 * belonging to named people — they are never given a public URL and never
 * appear in the media library. They leave only through an authenticated admin
 * route that streams them; see the attachment route.
 *
 * Separate prefixes are also what makes deleting a form's files possible
 * without touching anything else.
 */
export const ENTRY_PREFIX = "ctr-sports/entries/";

const BUCKET = process.env.S3_BUCKET;
const REGION = process.env.S3_REGION;

/**
 * Where the bucket lives, when it is not on AWS.
 *
 * The media moved from S3 to Neon's object storage, which speaks the same
 * protocol at a different address. Set, this does two things: points the
 * client at that address, and switches it to PATH-STYLE requests —
 * `https://host/bucket/key` rather than `https://bucket.host/key` — because
 * Neon's endpoint answers only the first form. Unset, everything below is the
 * plain AWS client it always was.
 */
const ENDPOINT = process.env.S3_ENDPOINT?.replace(/\/+$/, "") || "";

let client: S3Client | null = null;

function getClient(): S3Client {
  if (client) return client;

  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;

  if (!BUCKET || !REGION || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "S3 is not configured. Set S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY."
    );
  }

  client = new S3Client({
    region: REGION,
    credentials: { accessKeyId, secretAccessKey },
    ...(ENDPOINT ? { endpoint: ENDPOINT, forcePathStyle: true } : {}),
  });
  return client;
}

/** Lets the admin fall back to pasting a URL when the bucket is not wired up. */
export function isS3Configured(): boolean {
  return Boolean(
    process.env.S3_BUCKET &&
      process.env.S3_REGION &&
      process.env.S3_ACCESS_KEY_ID &&
      process.env.S3_SECRET_ACCESS_KEY
  );
}

/**
 * Public URL for a stored object — CloudFront's, unless nothing is configured.
 *
 * Two variables, one answer. NEXT_PUBLIC_MEDIA_BASE_URL is the one that matters
 * now: it is the same value the client-side constant in src/config/media.ts
 * reads, so one setting covers both the URLs written into the database on upload
 * and the ones the default images are built from. Setting only one of the two
 * was how the site ended up serving the same object from two hostnames.
 *
 * S3_PUBLIC_BASE_URL is kept, and kept FIRST, because it predates the media
 * domain and someone may already have it set; an env var that quietly stops
 * being read is worse than one that is merely redundant.
 *
 * Neither set falls back to the bucket's own public address — the path-style
 * one under `S3_ENDPOINT` when that is set, the virtual-hosted S3 one when it
 * is not — which works as long as the bucket stays publicly readable.
 */
export function publicUrl(key: string): string {
  const base = (
    process.env.S3_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_MEDIA_BASE_URL
  )?.replace(/\/+$/, "");

  if (base) return `${base}/${key}`;
  return ENDPOINT
    ? `${ENDPOINT}/${BUCKET}/${key}`
    : `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
}

/**
 * Uploads and returns the public URL. Objects are written under a content-hashed
 * or uuid key and never overwritten, so `immutable` is honest.
 */
export type MediaObject = {
  key: string;
  url: string;
  size: number;
  /** ISO string — the client only ever displays or sorts it. */
  uploadedAt: string;
};

/**
 * The cache header every uploaded object carries.
 *
 * Honest only because keys carry a full uuid and are never reused — see the
 * note on the key format in src/lib/mediaPaths.ts. It was an inline literal in
 * two places; it is one constant now because `presignUpload` has to SIGN the
 * exact same string, and two copies of a signed value is a bug waiting for the
 * day somebody edits one.
 */
const IMMUTABLE = "public, max-age=31536000, immutable";

/** A folder, as the browser needs to draw one. */
export type MediaFolder = { path: string; name: string };

export type MediaListing = {
  folder: string;
  folders: MediaFolder[];
  files: MediaObject[];
  /** The cap was hit. The screen says so rather than implying it saw everything. */
  truncated: boolean;
};

/**
 * `""` → the prefix itself; `"decks/2025"` → `ctr-sports/media/decks/2025/`.
 *
 * Exported for `entityMedia.ts`, which has to hand the same prefix to
 * `rewriteKeyPrefix` that the listing was taken with. Two ways of spelling one
 * prefix is how a move copies to one place and re-addresses to another.
 */
export function prefixFor(folder: string): string {
  return folder ? `${MEDIA_PREFIX}${folder}/` : MEDIA_PREFIX;
}

/**
 * The second lock, and the one that is here rather than at the edge.
 *
 * Every route already validates through `src/lib/mediaPaths.ts` before it gets
 * this far. This throws instead of trusting that, because the cost is a string
 * comparison and the thing on the other side of a mistake is somebody's licence
 * scan under `ctr-sports/entries/` — a sibling prefix, one character of
 * carelessness away.
 */
function assertUnderMedia(keyOrPrefix: string): void {
  if (!keyOrPrefix.startsWith(MEDIA_PREFIX)) {
    throw new Error(`Refusing to touch "${keyOrPrefix}" — it is not under the media prefix.`);
  }

  if (keyOrPrefix.includes("..") || keyOrPrefix.includes("%")) {
    throw new Error(`Refusing to touch "${keyOrPrefix}".`);
  }
}

/**
 * The three fields of an S3 object this file reads.
 *
 * Written out rather than imported from the SDK: `send()` is typed as a union
 * across every command it can take, so `Awaited<ReturnType<…>>` includes `void`
 * and nothing can be read off it. Three fields is a smaller lie than a cast.
 */
type S3Object = { Key?: string; Size?: number; LastModified?: Date };

/**
 * Every object under a prefix, following the continuation token.
 *
 * S3 returns at most 1000 keys per request and a token for the rest. The old
 * code sent one request with `MaxKeys: 1000` and no token, so on a bucket with
 * more than a thousand objects it saw the first thousand IN LEXICOGRAPHIC ORDER
 * and then sorted those by date — which looks exactly like a working
 * newest-first list right up until the newest upload is not in it.
 */
async function listAll(
  prefix: string,
  cap: number,
  delimiter?: string
): Promise<{ contents: S3Object[]; prefixes: string[]; truncated: boolean }> {
  assertUnderMedia(prefix);

  const contents: S3Object[] = [];
  const prefixes: string[] = [];
  let token: string | undefined;
  let truncated = false;

  do {
    const page = await getClient().send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        Delimiter: delimiter,
        MaxKeys: 1000,
        ContinuationToken: token,
      })
    );

    contents.push(...(page.Contents ?? []));
    for (const common of page.CommonPrefixes ?? []) {
      if (common.Prefix) prefixes.push(common.Prefix);
    }

    token = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (contents.length >= cap) truncated = Boolean(token);
  } while (token && contents.length < cap);

  return { contents: contents.slice(0, cap), prefixes, truncated };
}

const toMedia = (object: S3Object): MediaObject => ({
  key: object.Key ?? "",
  url: publicUrl(object.Key ?? ""),
  size: object.Size ?? 0,
  uploadedAt: (object.LastModified ?? new Date(0)).toISOString(),
});

/**
 * Everything under MEDIA_PREFIX, newest first.
 *
 * Signature and return shape unchanged, deliberately: this is the only contract
 * `GET /api/admin/media` and `MediaPicker` have, and the folder work must not
 * touch it. Two facts make that free — the `endsWith("/")` filter already drops
 * directory markers, and there is no `Delimiter`, so it already returns keys
 * from every folder flat, which is exactly what a "Recent" view wants.
 */
export async function listMedia(limit = 200): Promise<MediaObject[]> {
  const { contents } = await listAll(MEDIA_PREFIX, 5000);

  return contents
    .filter((object): object is typeof object & { Key: string } => Boolean(object.Key))
    // A "directory marker" is a zero-byte object ending in / — not an image.
    .filter((object) => !object.Key.endsWith("/"))
    .sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0))
    .slice(0, limit)
    .map(toMedia);
}

/**
 * One level of the tree: the folders directly inside, and the files.
 *
 * `Delimiter: "/"` is what makes S3 collapse everything below this level into
 * `CommonPrefixes` instead of returning it — the difference between listing a
 * folder and listing a subtree.
 *
 * Folders sort A→Z and files sort newest-first, which is two different natural
 * orders on one screen and is deliberate: a folder is a place and you look for
 * it by name, a file is a thing you just uploaded and you look for it at the
 * top.
 */
export async function listFolder(folder: string, cap = 2000): Promise<MediaListing> {
  const prefix = prefixFor(folder);
  const { contents, prefixes, truncated } = await listAll(prefix, cap, "/");

  const folders: MediaFolder[] = prefixes
    .map((full) => {
      const path = full.slice(MEDIA_PREFIX.length).replace(/\/$/, "");
      return { path, name: path.split("/").pop() ?? path };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const files = contents
    .filter((object) => object.Key && object.Key !== prefix && !object.Key.endsWith("/"))
    .sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0))
    .map(toMedia);

  return { folder, folders, files, truncated };
}

/**
 * Every object below a folder, at any depth, split into files and markers.
 *
 * No delimiter, so this is the whole subtree. The `cap` is what makes deleting
 * a folder a bounded operation rather than an open-ended one — a folder too big
 * to walk is one the route refuses and asks to be emptied in batches, which is
 * a worse experience than the alternative only if you have never watched a
 * delete run for four minutes and then fail.
 */
export async function listFolderDeep(
  folder: string,
  cap = 5000
): Promise<{ files: MediaObject[]; markers: string[]; truncated: boolean }> {
  const { contents, truncated } = await listAll(prefixFor(folder), cap);

  const files: MediaObject[] = [];
  const markers: string[] = [];

  for (const object of contents) {
    if (!object.Key) continue;
    if (object.Key.endsWith("/")) markers.push(object.Key);
    else files.push(toMedia(object));
  }

  files.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  return { files, markers, truncated };
}

/**
 * A zero-byte marker per level, so an intermediate folder is browsable before
 * anything has been put in it.
 *
 * `no-store` and NOT the immutable header, which is the one place in this file
 * where that would be a lie: a marker can legitimately be deleted and recreated
 * at the same key, which is exactly what `immutable` promises never happens.
 */
export async function createFolder(folder: string): Promise<void> {
  const segments = folderSegments(folder);
  if (segments.length === 0 || segments.length > MAX_FOLDER_DEPTH) {
    throw new Error(`"${folder}" is not a folder this library can create.`);
  }

  for (let depth = 1; depth <= segments.length; depth += 1) {
    const key = `${MEDIA_PREFIX}${segments.slice(0, depth).join("/")}/`;
    assertUnderMedia(key);

    await getClient().send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: "",
        ContentType: "application/x-directory",
        CacheControl: "no-store",
      })
    );
  }
}

/**
 * Whether anything is there — a marker, or children without one.
 *
 * `MaxKeys: 1` rather than `HeadObject`, which is both cheaper and, unlike it,
 * correct for a folder that has children but whose marker was deleted by hand.
 */
export async function folderExists(folder: string): Promise<boolean> {
  if (!folder) return true;

  const prefix = prefixFor(folder);
  assertUnderMedia(prefix);

  const page = await getClient().send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, MaxKeys: 1 })
  );

  return (page.KeyCount ?? 0) > 0;
}

/**
 * A URL the browser can PUT one file to, directly.
 *
 * This is what lifts the 4 MB ceiling: the bytes never pass through the server,
 * so a 25 MB PDF is not a request body Next has to buffer.
 *
 * `CacheControl` is SIGNED along with `ContentType`, which is what keeps the
 * immutable header on an object the server never touched. The client has to
 * echo both headers back exactly or S3 rejects the PUT — that is not a quirk to
 * work around, it is the signature doing its job.
 *
 * Honest limitation: a presigned PUT enforces the signed content type but NOT
 * the size the caller declared, so an authenticated admin could upload
 * something larger than they said. Acceptable — the caller is a trusted admin,
 * not the public. `@aws-sdk/s3-presigned-post` supports a `content-length-range`
 * condition if that ever stops being true.
 */
export async function presignUpload(
  key: string,
  contentType: string
): Promise<{ uploadUrl: string; headers: Record<string, string> }> {
  if (!isMediaKey(key)) throw new Error(`Refusing to sign "${key}".`);
  assertUnderMedia(key);

  const uploadUrl = await getSignedUrl(
    getClient(),
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: contentType,
      CacheControl: IMMUTABLE,
    }),
    { expiresIn: 60 }
  );

  return { uploadUrl, headers: { "Content-Type": contentType, "Cache-Control": IMMUTABLE } };
}

export async function uploadObject(key: string, body: Buffer, contentType: string): Promise<string> {
  await getClient().send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: IMMUTABLE,
    })
  );

  return publicUrl(key);
}

/**
 * The same, for something nobody outside the admin may read.
 *
 * `private` and `no-store` rather than the immutable public header above: these
 * objects are somebody's identity documents, and the difference between the two
 * functions is the difference between a logo and a passport photograph. The key
 * is unguessable either way, but "unguessable" is not a permission model —
 * nothing ever hands out the URL, and the only way to read one is through an
 * authenticated route.
 */
export async function uploadPrivateObject(
  key: string,
  body: Buffer,
  contentType: string
): Promise<void> {
  await getClient().send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: "private, no-store",
    })
  );
}

/** The bytes of one object, for streaming back through an authed route. */
export async function getObject(
  key: string
): Promise<{ body: Uint8Array; contentType: string } | null> {
  try {
    const result = await getClient().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const body = await result.Body?.transformToByteArray();
    if (!body) return null;

    return { body, contentType: result.ContentType ?? "application/octet-stream" };
  } catch {
    // A missing key is a 404 to the caller, not a 500 — an entry can outlive
    // its file if somebody has been into the bucket by hand.
    return null;
  }
}

/**
 * One object at a new key. S3 has no rename, and this is the half of one.
 *
 * `MetadataDirective` is left at its default of COPY, which carries the source's
 * `ContentType` and `CacheControl` across untouched. The explicit alternative —
 * REPLACE with `IMMUTABLE` written in — would need a `HeadObject` first to learn
 * the content type, so it is a round trip bought for nothing, and it would
 * quietly stamp `immutable` onto a directory marker that was deliberately
 * written `no-store`.
 *
 * `CopySource` is the one place in this file a key is URL-encoded. It travels as
 * a header rather than a signed path element, and `parseSegment` permits spaces
 * in a folder name, so a raw key would break the request the first time somebody
 * made a folder called "2025 season". `encodeURI` is the right tool: it escapes
 * the space and leaves the separators alone. It cannot double-encode, because a
 * key containing `%` never gets this far — `assertUnderMedia` refuses it.
 */
export async function copyObject(from: string, to: string): Promise<void> {
  assertUnderMedia(from);
  assertUnderMedia(to);

  await getClient().send(
    new CopyObjectCommand({
      Bucket: BUCKET,
      CopySource: encodeURI(`${BUCKET}/${from}`),
      Key: to,
    })
  );
}

/**
 * Every file under one folder copied to the same place under another.
 *
 * COPIES. It does not delete, and the omission is the point: the caller has to
 * rewrite the database between the copy and the delete, so that a failure
 * anywhere in the middle leaves duplicate objects rather than a row pointing at
 * a key that is no longer there. Duplicates can be re-run away. A 404 on a live
 * page cannot. See `moveEntityFolder` in src/lib/server/entityMedia.ts, which is
 * the only thing that should call this.
 *
 * Bounded by `listFolderDeep`'s cap, and it refuses a truncated listing outright
 * rather than moving the part of a folder it could see — a half-moved folder is
 * the one outcome worse than a failed move, because nothing afterwards can tell
 * which half is which.
 */
export async function copyFolder(
  from: string,
  to: string
): Promise<{ pairs: { from: string; to: string }[]; markers: string[] }> {
  const { files, markers, truncated } = await listFolderDeep(from);

  if (truncated) {
    throw new Error(`"${from}" holds too many files to move in one go.`);
  }

  const fromPrefix = prefixFor(from);
  const toPrefix = prefixFor(to);

  const pairs = files.map((file) => ({
    from: file.key,
    to: `${toPrefix}${file.key.slice(fromPrefix.length)}`,
  }));

  // The destination's own markers, so an empty-but-real folder survives the move
  // and the explorer can show it before anything lands in it.
  await createFolder(to);

  // Ten at a time. Sequential is a minute for a fifty-page deck and unbounded
  // parallelism is a burst of fifty signed requests; neither is worth defending.
  for (let at = 0; at < pairs.length; at += 10) {
    await Promise.all(pairs.slice(at, at + 10).map((pair) => copyObject(pair.from, pair.to)));
  }

  return { pairs, markers };
}

/**
 * Removes objects, in batches of the thousand the API allows.
 *
 * Needed the moment attachments exist: deleting a form cascades its entries in
 * Postgres, and without this the bucket would go on holding the licence scans
 * of everyone who ever entered it — with the only record of which files those
 * were sitting in the rows that were just deleted.
 */
export async function deleteObjects(keys: string[]): Promise<void> {
  const wanted = keys.filter(Boolean);
  if (wanted.length === 0) return;

  for (let from = 0; from < wanted.length; from += 1000) {
    await getClient().send(
      new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: wanted.slice(from, from + 1000).map((Key) => ({ Key })) },
      })
    );
  }
}
