/**
 * Moves the media URLs already sitting in the database onto the new host.
 *
 *   npm run migrate:media -- --dry-run     count what would change
 *   npm run migrate:media                  change it
 *
 * ── Why this is needed at all ─────────────────────────────────────────────
 *
 * `publicUrl()` returns an ABSOLUTE URL and the admin stores exactly what the
 * upload route handed back (src/admin/components/ImageField.tsx,
 * src/admin/screens/decks/DeckForm.tsx), while `normalise.image()` passes any
 * http(s) string straight through. So every row written before the CDN existed
 * holds the raw S3 hostname, and setting NEXT_PUBLIC_MEDIA_BASE_URL only
 * changes what NEW uploads get. This is the one-shot that catches up the rest.
 *
 * Run it AFTER the distribution is live and the code is deployed, and BEFORE
 * the bucket's public-read policy comes off — an object whose URL is still the
 * S3 one keeps working right up until that last step, and then does not.
 *
 * ── What it touches ───────────────────────────────────────────────────────
 *
 * Every column that can hold an image URL, per migrations/0001_baseline.sql.
 * The JSONB ones are replaced through their text form, which is safe because a URL
 * contains no character JSON escapes — and jsonb is already normalised on
 * storage, so the round-trip changes nothing but the string.
 *
 * `forms.fields` / `sections` and `tracks.links` are in the list even
 * though nothing writes an upload into them, because their text is
 * author-written and an editor can paste one. A pasted URL that is missed here
 * is a picture that vanishes the day the bucket goes private.
 *
 * NOT touched, deliberately:
 *   form_entries.answers  registration attachments live under ENTRY_PREFIX,
 *                             are never given a public URL, and leave only
 *                             through an authenticated route that streams them.
 *                             They have no host in them to rewrite.
 *   enquiries                 nothing renders a URL out of a stranger's message.
 *   tracks.svg_path           an inline SVG `d` attribute, not an address.
 *
 * `updated_at` is left alone. The admin screens read it as "somebody edited
 * this", and re-addressing the same photograph is not an edit — the pictures
 * are identical, only the road to them changed.
 *
 * ── Life expectancy ───────────────────────────────────────────────────────
 *
 * One-shot, and it has now outlived two schema changes without being run.
 * It copes with both:
 *
 *   the NAME    0001 moved these tables into a `ctr` schema and dropped the
 *               prefix, so each is looked up through `to_regclass` and answers
 *               to `ctr.decks` or `public.ctr_decks`, whichever is there.
 *   the SHAPE   0006 took the page documents apart and 0008 dropped
 *               `content` outright, so the column list is chosen from the
 *               schema this database actually has — see SCHEMAS below.
 *
 * That is the whole of the accommodation, and it is more than a one-shot should
 * need. Once this has run against production it is spent: delete it rather than
 * leaving it lying around looking like a tool.
 */
import { neon } from "@neondatabase/serverless";

/**
 * Every column that can hold one, in whichever schema this database has.
 *
 * The restructure moved these. Before it, the URLs sat in four JSONB documents
 * and a handful of text columns; after it they are ordinary indexed columns in
 * a dozen tables, and `ctr.content` — which held most of them — does not exist
 * at all. This script had not been run when that landed, so it has to know both.
 *
 * `SCHEMAS.new` is chosen when `page_sections` exists, which is the marker that
 * 0006 has been applied.
 */
const SCHEMAS = {
  old: [
    { table: "content", what: "the landing and INCRC documents", columns: [{ name: "content", json: true }] },
    { table: "decks", what: "deck page images", columns: [{ name: "pages", json: true }] },
    { table: "sports", what: "sport logos and photos", columns: [{ name: "logo_url" }, { name: "photo_url" }] },
    {
      table: "tracks",
      what: "circuit photos, layout maps and related links",
      columns: [{ name: "photo_url" }, { name: "map_url" }, { name: "links", json: true }],
    },
    {
      table: "forms",
      what: "anything pasted into a form's questions or sections",
      columns: [{ name: "fields", json: true }, { name: "sections", json: true }],
    },
  ],
  new: [
    { table: "page_sections", what: "every section of both pages", columns: [{ name: "data", json: true }] },
    { table: "banners", what: "banner photographs", columns: [{ name: "image" }] },
    { table: "posts", what: "newsroom photographs", columns: [{ name: "image" }] },
    { table: "partners", what: "partner marks", columns: [{ name: "logo" }] },
    { table: "deck_pages", what: "deck page images", columns: [{ name: "url" }] },
    { table: "sports", what: "sport logos and photos", columns: [{ name: "logo_url" }, { name: "photo_url" }] },
    {
      table: "tracks",
      what: "circuit photos and layout maps",
      columns: [{ name: "photo_url" }, { name: "map_url" }],
    },
    { table: "track_links", what: "related links on a circuit", columns: [{ name: "href" }] },
    {
      table: "forms",
      what: "anything pasted into a form's questions or sections",
      columns: [{ name: "fields", json: true }, { name: "sections", json: true }],
    },
    /*
     * Both shapes at once: a cover is a plain column and a body is a document
     * holding every picture dropped into the middle of the text.
     *
     * These two were missing until the CDN was actually put in front of the
     * bucket, because the script predates both tables — `articles` arrived with
     * 0010 and `events` with 0018, and a one-shot that has never run is a
     * one-shot nobody notices going stale. `src/lib/server/mediaRefs.ts` has the
     * complete list; this now matches it.
     */
    { table: "articles", what: "article covers and pictures inside them",
      columns: [{ name: "cover_image" }, { name: "body", json: true }] },
    { table: "events", what: "event covers and pictures inside them",
      columns: [{ name: "cover_image" }, { name: "body", json: true }] },
    /* 0021. A cover and nothing else. */
    { table: "seasons", what: "season covers", columns: [{ name: "cover_image" }] },
  ],
};

const DRY_RUN = process.argv.includes("--dry-run");

/** `--from=https://…`. Both ends can be overridden for a second CDN move. */
function flag(name) {
  const found = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : "";
}

const trimSlashes = (value) => value.replace(/\/+$/, "");

const BUCKET = process.env.S3_BUCKET;
const REGION = process.env.S3_REGION;

/*
 * The old address is the one publicUrl() used to build, and the new one is what
 * it builds now — same precedence, so the rows land on exactly the host the
 * next upload will get. Neither is written down in this file.
 */
const FROM = trimSlashes(
  flag("from") || (BUCKET && REGION ? `https://${BUCKET}.s3.${REGION}.amazonaws.com` : "")
);

const TO = trimSlashes(
  flag("to") || process.env.S3_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_MEDIA_BASE_URL || ""
);

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  fail("DATABASE_URL is not set. Make sure .env exists in the project root.");
}

if (!FROM) {
  fail(
    "Nothing to migrate FROM. Set S3_BUCKET and S3_REGION, or pass --from=https://old-host"
  );
}

if (!TO) {
  fail(
    "Nothing to migrate TO. Set NEXT_PUBLIC_MEDIA_BASE_URL, or pass --to=https://media.example.com"
  );
}

if (FROM === TO) {
  fail(`The old and new hosts are the same (${FROM}). Nothing to do.`);
}

/*
 * Re-running has to be a no-op, and it is: once a row says the new host it no
 * longer contains the old string. That only holds while the new host does not
 * CONTAIN the old one — "https://x.com" → "https://x.com.cdn.net" would eat
 * itself a second character deeper on every run. Refuse rather than corrupt.
 */
if (TO.includes(FROM)) {
  fail(`The new host contains the old one (${FROM} ⊂ ${TO}). That would not be idempotent.`);
}

const sql = neon(process.env.DATABASE_URL);

/**
 * Which restructure this database has had.
 *
 * `page_sections` is the marker: it is created by 0006 and by nothing else, so
 * its presence says the documents have been taken apart, and its absence says
 * the URLs are still in the JSONB they were written into.
 */
async function chooseSchema() {
  const [row] = await sql.query(
    `SELECT coalesce(to_regclass('ctr.page_sections'), to_regclass('public.page_sections'))
              IS NOT NULL AS decomposed`
  );

  return row.decomposed ? "new" : "old";
}

/**
 * Whichever of the two names this database answers to, fully qualified.
 *
 * `to_regclass` returns null rather than raising for a name that is not there,
 * which is what makes asking about both cheap. Null from both means the table
 * does not exist at all — a database this script has no business writing to.
 */
async function resolveTable(name) {
  const [row] = await sql.query(
    `SELECT coalesce(to_regclass('ctr.' || $1), to_regclass('public.ctr_' || $1))::text AS name`,
    [name]
  );

  return row.name;
}

/** `strpos`, not LIKE: the needle is a literal, and % and _ are not wildcards in it. */
const matches = (column) => `strpos(${column.json ? `${column.name}::text` : column.name}, $1) > 0`;

const rewrite = (column) =>
  column.json
    ? `${column.name} = replace(${column.name}::text, $1, $2)::jsonb`
    : `${column.name} = replace(${column.name}, $1, $2)`;

/**
 * Rows still carrying the old host, per column — and how many URLs are in them.
 *
 * The row count alone is not something anyone can eyeball: `content` is two
 * rows whatever happens, and the question is whether they hold the eleven
 * addresses you expect or one. Occurrences are counted the only way SQL offers,
 * by how much shorter the text gets with the needle taken out of it.
 *
 * Table and column names are the literals in TARGETS, never input; the needle
 * is a parameter.
 */
async function countMatches(table, columns) {
  return await Promise.all(
    columns.map(async (column) => {
      const text = column.json ? `${column.name}::text` : column.name;

      const [row] = await sql.query(
        `SELECT count(*)::int AS rows,
                coalesce(sum((length(${text}) - length(replace(${text}, $1, ''))) / length($1)), 0)::int AS hits
           FROM ${table}
          WHERE ${matches(column)}`,
        [FROM]
      );

      return { column: column.name, rows: row.rows, hits: row.hits };
    })
  );
}

console.log(DRY_RUN ? "DRY RUN — nothing will be written.\n" : "Rewriting media URLs.\n");
console.log(`  from  ${FROM}`);
console.log(`  to    ${TO}\n`);

try {
  const shape = await chooseSchema();
  const TARGETS = SCHEMAS[shape];
  console.log(`  schema: ${shape === "new" ? "decomposed (0006 applied)" : "the original documents"}\n`);

  let pending = 0;
  let urls = 0;
  let written = 0;

  for (const { table, what, columns } of TARGETS) {
    const resolved = await resolveTable(table);

    if (!resolved) {
      /*
       * `articles` and `events` arrived long after this script did, so a
       * database that predates them is not a database this is pointed at by
       * mistake — it is one that simply has nothing of theirs to rewrite.
       */
      if (table === "articles" || table === "events" || table === "seasons") {
        console.log(`  ${table.padEnd(20)} —  not on this database yet (${what})`);
        continue;
      }

      fail(`No ${table} table under either name. Is DATABASE_URL pointing at the right database?`);
    }

    const counts = await countMatches(resolved, columns);
    const total = counts.reduce((sum, count) => sum + count.rows, 0);
    const hits = counts.reduce((sum, count) => sum + count.hits, 0);
    pending += total;
    urls += hits;

    const detail = counts
      .filter((count) => count.rows > 0)
      .map((count) => `${count.column} ${count.rows}×${count.hits}`)
      .join(", ");

    if (total === 0) {
      console.log(`  ${resolved.padEnd(20)} —  nothing to do (${what})`);
      continue;
    }

    console.log(
      `  ${resolved.padEnd(20)} ${String(total).padStart(3)} row(s), ` +
        `${String(hits).padStart(3)} URL(s)  [${detail}]`
    );

    if (DRY_RUN) continue;

    // One statement per table: a row matching on two columns is updated once,
    // and a column that does not match is rewritten to the value it already has.
    const changed = await sql.query(
      `UPDATE ${resolved}
          SET ${columns.map(rewrite).join(", ")}
        WHERE ${columns.map(matches).join(" OR ")}
        RETURNING 1`,
      [FROM, TO]
    );

    written += changed.length;
  }

  console.log("");

  if (pending === 0) {
    console.log("Every row is already on the new host. Nothing changed.");
    process.exit(0);
  }

  if (DRY_RUN) {
    console.log(
      `${pending} row(s) holding ${urls} URL(s) would be rewritten. ` +
        "Re-run without --dry-run to do it."
    );
    process.exit(0);
  }

  console.log(`Rewrote ${written} row(s), ${urls} URL(s).`);

  // Say it out of the database rather than out of the counters above, which is
  // the difference between "the statements ran" and "the rows changed".
  let left = 0;
  for (const { table, columns } of TARGETS) {
    const resolved = await resolveTable(table);
    if (!resolved) continue;

    const counts = await countMatches(resolved, columns);
    left += counts.reduce((sum, count) => sum + count.rows, 0);
  }

  if (left > 0) {
    fail(`${left} row(s) still carry the old host. Something is wrong — do not lock the bucket.`);
  }

  console.log("Verified: no row carries the old host any more.");
} catch (error) {
  console.error("Failed:", error.message);
  process.exit(1);
}
