/**
 * Copies every object under a prefix from one S3-compatible bucket to another.
 *
 *   npm run migrate:storage -- --dry-run          list what would be copied
 *   npm run migrate:storage                       copy it
 *   npm run migrate:storage -- --prefix=ctr-sports/entries/
 *
 * ── What it is for ────────────────────────────────────────────────────────
 *
 * Moving the site's media off AWS S3 (behind CloudFront) onto Neon's object
 * storage. The two speak the same protocol, so this is one client reading and
 * another writing — but S3 has no cross-account, cross-provider copy, so every
 * byte streams through this process once.
 *
 * The DESTINATION is the bucket the app is configured for: the ordinary `S3_*`
 * variables in .env, plus `S3_ENDPOINT` for anything that is not AWS. The
 * SOURCE is the old bucket, given as `S3_SOURCE_*` — the same five names with
 * SOURCE in them — so the old credentials never have to live in .env once the
 * app has moved.
 *
 * ── What it does NOT do ───────────────────────────────────────────────────
 *
 * Delete anything. It copies, verifies that every source key exists at the
 * destination with the same size, and stops. The old bucket is the backup
 * until somebody has looked at the site and decided it is not needed any more;
 * a script that deletes as it goes has nothing to fall back on when the site
 * turns out to be missing a picture.
 *
 * Rewrite the database. The rows still point at the old host afterwards —
 * `npm run migrate:media -- --from=<old> --to=<new>` is what moves them, and
 * it should run AFTER this has verified, never before.
 *
 * ── Re-runnable ───────────────────────────────────────────────────────────
 *
 * A key that already exists at the destination with the same size is skipped,
 * so an interrupted run picks up where it stopped and a second run after the
 * site has kept uploading to the old bucket copies only what is new.
 *
 * `ContentType` and `Cache-Control` are carried across, because the app's
 * `immutable` header is set on upload and never touched again: an object that
 * arrived without it would be re-fetched on every page view for the rest of
 * its life.
 */
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const DRY_RUN = process.argv.includes("--dry-run");

function flag(name, fallback = "") {
  const found = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

const PREFIX = flag("prefix", "ctr-sports/");
const CONCURRENCY = Number(flag("concurrency", "3"));

function fail(message) {
  console.error(message);
  process.exit(1);
}

function clientFrom(names, label) {
  const bucket = process.env[names.bucket];
  const region = process.env[names.region];
  const accessKeyId = process.env[names.key];
  const secretAccessKey = process.env[names.secret];
  const endpoint = process.env[names.endpoint]?.replace(/\/+$/, "");

  if (!bucket || !region || !accessKeyId || !secretAccessKey) {
    fail(
      `The ${label} bucket is not configured. Set ${names.bucket}, ${names.region}, ` +
        `${names.key} and ${names.secret}` +
        (names.endpoint ? ` (and ${names.endpoint} if it is not AWS).` : ".")
    );
  }

  const client = new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    /*
     * The SDK's default is to wait forever on a socket that has gone quiet,
     * and AWS drops long downloads without saying so. Four workers each sat
     * on a dead connection for a quarter of an hour once; now a connection
     * that sends nothing for ninety seconds is an error, and errors retry.
     */
    requestHandler: { connectionTimeout: 15_000, requestTimeout: 90_000 },
  });

  return { client, bucket, where: endpoint ? `${endpoint}/${bucket}` : `s3://${bucket} (${region})` };
}

const source = clientFrom(
  {
    bucket: "S3_SOURCE_BUCKET",
    region: "S3_SOURCE_REGION",
    key: "S3_SOURCE_ACCESS_KEY_ID",
    secret: "S3_SOURCE_SECRET_ACCESS_KEY",
    endpoint: "S3_SOURCE_ENDPOINT",
  },
  "source"
);

const target = clientFrom(
  {
    bucket: "S3_BUCKET",
    region: "S3_REGION",
    key: "S3_ACCESS_KEY_ID",
    secret: "S3_SECRET_ACCESS_KEY",
    endpoint: "S3_ENDPOINT",
  },
  "destination"
);

if (source.where === target.where) {
  fail(`Source and destination are the same bucket (${source.where}). Nothing to do.`);
}

/** Every object under the prefix, following the continuation token. */
async function listAll({ client, bucket }) {
  const objects = [];
  let token;

  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIX, MaxKeys: 1000, ContinuationToken: token })
    );
    for (const object of page.Contents ?? []) {
      if (object.Key) objects.push({ key: object.Key, size: object.Size ?? 0 });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  return objects;
}

const megabytes = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

/**
 * Read the whole object into memory, then write it.
 *
 * Not streamed from one client into the other, deliberately. It was, and a
 * connection reset from the source halfway through a video surfaced as an
 * error on a socket nobody was listening to, which took the whole process
 * down rather than failing one object. The largest thing in the bucket is a
 * hundred and forty megabytes; holding a few of those at once is cheap, and a
 * failure now happens inside a promise this function can retry.
 *
 * ── The watchdog ──────────────────────────────────────────────────────────
 *
 * The SDK's own timeout covers the wait for a response to BEGIN. A download
 * that starts and then goes silent — which is how AWS drops a long transfer
 * from far away — is not covered by it, and twice a worker sat on one for a
 * quarter of an hour. So the body is read chunk by chunk, and a chunk that is
 * more than a minute in coming aborts the request; the retry loop does the
 * rest. The upload gets a budget from its size, generous enough for a slow
 * line and short enough that a dead one is noticed.
 */
const ATTEMPTS = 5;
const STALL_MS = 60_000;

async function download(key) {
  const controller = new AbortController();
  let watchdog;
  const arm = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => controller.abort(new Error(`no data for ${STALL_MS / 1000}s`)), STALL_MS);
  };

  arm();
  const got = await source.client.send(
    new GetObjectCommand({ Bucket: source.bucket, Key: key }),
    { abortSignal: controller.signal }
  );

  const chunks = [];
  try {
    for await (const chunk of got.Body) {
      chunks.push(chunk);
      arm();
    }
  } catch (error) {
    got.Body.destroy?.();
    throw controller.signal.aborted ? controller.signal.reason : error;
  } finally {
    clearTimeout(watchdog);
  }

  return { ...got, body: Buffer.concat(chunks) };
}

async function upload(key, got, size) {
  const controller = new AbortController();
  // Fifty kilobytes a second, and never less than two minutes.
  const budget = Math.max(120_000, (got.body.byteLength / 50_000) * 1000);
  const timer = setTimeout(() => controller.abort(new Error(`upload exceeded ${Math.round(budget / 1000)}s`)), budget);

  try {
    await target.client.send(
      new PutObjectCommand({
        Bucket: target.bucket,
        Key: key,
        Body: got.body,
        ContentLength: got.body.byteLength || size,
        ContentType: got.ContentType,
        CacheControl: got.CacheControl,
        ContentDisposition: got.ContentDisposition,
        Metadata: got.Metadata,
      }),
      { abortSignal: controller.signal }
    );
  } catch (error) {
    throw controller.signal.aborted ? controller.signal.reason : error;
  } finally {
    clearTimeout(timer);
  }
}

async function copyOne({ key, size }) {
  let lastError;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const got = await download(key);
      await upload(key, got, size);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < ATTEMPTS) {
        console.log(`  retry ${attempt}/${ATTEMPTS - 1}  ${key}  (${error.code ?? error.name}: ${error.message})`);
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      }
    }
  }

  throw lastError;
}

/** A few at a time: enough to keep the pipe busy, few enough to not be a burst. */
async function inBatches(items, worker) {
  let at = 0;
  const failures = [];

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (at < items.length) {
        const item = items[at++];
        try {
          await worker(item);
        } catch (error) {
          failures.push({ key: item.key, error: error.message });
          console.log(`  FAILED  ${item.key}\n          ${error.message}`);
        }
      }
    })
  );

  return failures;
}

// A socket error that surfaces outside any promise must not take down a run
// that is otherwise going well: log it, and let the verification at the end
// say which object it cost.
process.on("uncaughtException", (error) => {
  console.log(`  stray error, ignored: ${error.code ?? error.name}: ${error.message}`);
});

console.log(DRY_RUN ? "DRY RUN — nothing will be written.\n" : "Copying objects.\n");
console.log(`  from    ${source.where}`);
console.log(`  to      ${target.where}`);
console.log(`  prefix  ${PREFIX}\n`);

try {
  const [wanted, already] = await Promise.all([listAll(source), listAll(target)]);
  const present = new Map(already.map((object) => [object.key, object.size]));

  const pending = wanted.filter((object) => present.get(object.key) !== object.size);
  const skipped = wanted.length - pending.length;
  const bytes = pending.reduce((sum, object) => sum + object.size, 0);

  console.log(
    `  ${wanted.length} object(s) at the source, ${skipped} already at the destination, ` +
      `${pending.length} to copy (${megabytes(bytes)}).\n`
  );

  if (pending.length === 0) {
    console.log("Nothing to copy.");
    process.exit(0);
  }

  if (DRY_RUN) {
    for (const object of pending) console.log(`  ${megabytes(object.size).padStart(9)}  ${object.key}`);
    console.log("\nRe-run without --dry-run to copy them.");
    process.exit(0);
  }

  let done = 0;
  const failures = await inBatches(pending, async (object) => {
    await copyOne(object);
    done += 1;
    console.log(`  ${String(done).padStart(4)}/${pending.length}  ${megabytes(object.size).padStart(9)}  ${object.key}`);
  });

  console.log("");

  // Verified out of the destination, not out of the counter: the difference
  // between "the requests returned" and "the objects are there".
  const after = new Map((await listAll(target)).map((object) => [object.key, object.size]));
  const missing = wanted.filter((object) => after.get(object.key) !== object.size);

  if (failures.length > 0 || missing.length > 0) {
    for (const object of missing) console.log(`  MISSING  ${object.key}`);
    fail(
      `\n${failures.length} copy(ies) failed and ${missing.length} object(s) are missing or the wrong size ` +
        "at the destination. Re-run to retry them; do not rewrite the database yet."
    );
  }

  console.log(`Copied ${done} object(s), ${megabytes(bytes)}.`);
  console.log(`Verified: every object under ${PREFIX} is at the destination with the right size.`);

  // The spot check that matters most: an object the site serves is readable
  // without credentials, because that is how a browser will ask for it.
  const sample = wanted.find((object) => object.key.startsWith("ctr-sports/media/") && !object.key.endsWith("/"));
  if (sample && process.env.S3_ENDPOINT) {
    const url = `${process.env.S3_ENDPOINT.replace(/\/+$/, "")}/${target.bucket}/${encodeURI(sample.key)}`;
    const response = await fetch(url, { method: "HEAD" });
    console.log(
      response.ok
        ? `Public read works: ${url}`
        : `WARNING: ${url} answered ${response.status}. The bucket is not publicly readable — fix that before rewriting the database.`
    );
  }
} catch (error) {
  console.error("Failed:", error.message);
  process.exit(1);
}
