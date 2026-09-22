import "server-only";

import { getSql } from "@/lib/server/db";

/**
 * What points at an uploaded file, before anybody deletes it.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * Deleting an object does not un-break a page. `max-age=31536000, immutable`
 * means a browser or a CDN may go on serving a deleted file for up to a year,
 * so a delete has no visible effect at all and then, months later, a picture
 * vanishes from a page nobody was editing. There is no undo and no obvious
 * cause. That gap between the action and the consequence is why this scan is
 * mandatory rather than advisory, and why the dialog in front of it says so in
 * words rather than a warning triangle.
 *
 * ── Why it pulls the text once instead of querying per key ────────────────
 *
 * The obvious shape is a `LIKE` per key, UNION'd. That is one round trip per
 * key through the Neon HTTP driver, so deleting a folder of two hundred files
 * would be two hundred round trips. Inverted here: pull the candidate columns
 * once, match in memory, resolve ids to names in the same pass. **Eight queries
 * total, however many keys are asked about.**
 *
 * Safe HERE AND ONLY HERE because these tables are tiny by construction —
 * `page_sections` is two pages' worth of sections, and the rest are
 * hand-curated lists of tens. If any of them ever grows past a few thousand
 * rows, switch to the per-key form; the `console.warn` below is what makes the
 * day that happens visible instead of gradual.
 *
 * ── What changed with the restructure ─────────────────────────────────────
 *
 * This was specified against the old schema: five queries over `ctr_content`,
 * `ctr_decks`, `ctr_sports`, `ctr_tracks` and `ctr_forms`, pulling whole JSONB
 * blobs as text. Four of those tables no longer hold URLs — `content` does not
 * exist, deck pages are rows, track links are rows. So the scan follows the
 * data:
 *
 *   page_sections.data   still a document, still matched as text
 *   banners.image        an exact-match column now
 *   posts.image          "
 *   partners.logo        "
 *   deck_pages.url       "
 *   sports               logo_url and photo_url, as before
 *   tracks               photo_url and map_url; links moved to track_links.href
 *   forms                fields and sections stay JSONB, so still text
 *   articles             cover_image is a column, body is a document
 *   events               the same two shapes as an article
 *   seasons              cover_image, and nothing else
 *
 * The originally-stated reasoning — "pull the text once, match in memory" —
 * therefore only applies to the three that are still documents. The rest are
 * ordinary indexed columns and a URL either equals one or does not, so those
 * are matched with `= ANY($1)` and the database does the work. That is a better
 * scan than the one specified, not a compromise on it.
 *
 * ── Two things it cannot do ───────────────────────────────────────────────
 *
 * It is a SNAPSHOT, not a lock. Somebody can save a page referencing a file
 * between the scan and the delete. The window is seconds, and the delete route
 * re-checks on confirm and answers 409 again if it changed — but there is no
 * advisory-lock mechanism anywhere in this app and this is not the place to
 * invent one.
 *
 * And it can only see THIS database. Not
 * a URL somebody pasted into an external document, an email, or the older CTR
 * site. Which is why the dialog says "nothing on this site points at these"
 * rather than "this is unused".
 */

export type UsageRef = {
  kind: "content" | "deck" | "sport" | "track" | "form" | "article" | "event" | "season" | "source";
  label: string;
  /**
   * The SLUG of the site this reference belongs to, or null for one that
   * belongs to no site.
   *
   * Carried so a delete can be REFUSED rather than merely warned about. Folder
   * permission stops a pickleball editor reaching into `incrc/`; it does not
   * stop them deleting a file out of their own folder that the INCRC page
   * happens to use, because the media library offers every picture to every
   * screen. This field is what closes that: you may confirm past a usage
   * warning only if every site named is one you administer. See
   * `canOverrideUsage`.
   *
   * A slug rather than an id, because that is what the folder predicates in
   * `src/lib/mediaPaths.ts` compare against and what a human reading the
   * warning recognises.
   *
   * Null is deliberately the STRICTEST value, not the most permissive: only an
   * owner can override it, which is the right answer for a file the code
   * itself depends on.
   */
  site: string | null;
};

export type KeyUsage = { key: string; refs: UsageRef[] };

/** Past this, the pull-it-all-in-memory bet stops being a good one. */
const TOO_MANY = 2000;
let warned = false;

/**
 * Nothing is pinned from the source any more, and there is nothing left to pin.
 *
 * This used to walk `src/config/images.ts` — three tables of photography the
 * pages fell back to — and pin any upload among them, because a database-only
 * scan called them unreferenced and deleting one broke the site during an
 * outage, when nobody could see why.
 *
 * Those tables are gone. Every photograph on both pages is a row now, seeded
 * from scripts/seed-data/*.json, so the database scan below already sees all of
 * them: a picture in use is a picture some row points at, with no second list to
 * keep in step. What remains in that file is one /public placeholder, which is
 * not an upload and cannot be deleted from the media library.
 *
 * Kept as a function rather than deleted outright because the caller's shape is
 * "everything the database knows, plus everything the code does" — and the day
 * something is referenced from the source again, this is where it says so.
 */
function sourcePinnedKeys(): Set<string> {
  return new Set<string>();
}

/**
 * Everything that points at any of these keys.
 *
 * Batch only. A single-key variant would be `findUsage([key])[0]` and a second
 * entry point is a second thing to keep in step with this one.
 *
 * The needle is the KEY, never the URL. `publicUrl` appends the whole key to
 * whatever base it has, so dropping the host is what makes this survive a CDN
 * being put in front of the bucket — which has since happened. `encodeURI` is
 * matched as well, as insurance for a legacy object; the key charset never
 * percent-encodes, so it can only ever be belt and braces.
 */
export async function findUsage(keys: string[]): Promise<KeyUsage[]> {
  const wanted = [...new Set(keys.filter((key) => typeof key === "string" && key))];
  if (wanted.length === 0) return [];

  const sql = getSql();
  const encoded = wanted.map((key) => encodeURI(key));

  const [sections, banners, posts, partners, deckPages, columns, documents, articles, events, seasons] =
    await Promise.all([
    sql`SELECT si.slug AS site, si.name AS site_name, ps.type, ps.data::text AS blob
           FROM ctr.page_sections ps
           JOIN ctr.pages pg ON pg.id = ps.page_id
           JOIN ctr.sites si ON si.id = pg.site_id`,

    sql`SELECT si.slug AS site, si.name AS site_name, b.image AS url
           FROM ctr.banners b
           JOIN ctr.page_sections ps ON ps.id = b.section_id
           JOIN ctr.pages pg ON pg.id = ps.page_id
           JOIN ctr.sites si ON si.id = pg.site_id
          WHERE b.image = ANY(${wanted}::text[]) OR b.image = ANY(${encoded}::text[])
             OR EXISTS (SELECT 1 FROM unnest(${wanted}::text[]) AS k(key)
                         WHERE position(k.key in b.image) > 0)`,

    sql`SELECT si.slug AS site, si.name AS site_name, p.image AS url
           FROM ctr.posts p
           JOIN ctr.page_sections ps ON ps.id = p.section_id
           JOIN ctr.pages pg ON pg.id = ps.page_id
           JOIN ctr.sites si ON si.id = pg.site_id
          WHERE EXISTS (SELECT 1 FROM unnest(${wanted}::text[]) AS k(key)
                         WHERE position(k.key in p.image) > 0)`,

    sql`SELECT si.slug AS site, si.name AS site_name, pr.logo AS url
           FROM ctr.partners pr
           JOIN ctr.page_sections ps ON ps.id = pr.section_id
           JOIN ctr.pages pg ON pg.id = ps.page_id
           JOIN ctr.sites si ON si.id = pg.site_id
          WHERE EXISTS (SELECT 1 FROM unnest(${wanted}::text[]) AS k(key)
                         WHERE position(k.key in pr.logo) > 0)`,

    sql`SELECT d.name, si.slug AS site, p.url
           FROM ctr.deck_pages p
           JOIN ctr.decks d ON d.id = p.deck_id
           JOIN ctr.sites si ON si.id = d.site_id
          WHERE EXISTS (SELECT 1 FROM unnest(${wanted}::text[]) AS k(key)
                         WHERE position(k.key in p.url) > 0)`,

    // The plain columns, all at once. Every one of these is a whole URL, so the
    // database can answer without anything being pulled into memory.
    sql`
      SELECT 'sport' AS kind, s.title AS label,
             coalesce(s.logo_url, '') || ' ' || coalesce(s.photo_url, '') AS blob,
             (SELECT slug FROM ctr.sites WHERE kind = 'root') AS site
        FROM ctr.sports s
      UNION ALL
      SELECT 'track', t.name,
             coalesce(t.photo_url, '') || ' ' || coalesce(t.map_url, ''),
             (SELECT slug FROM ctr.sites WHERE id = t.site_id)
        FROM ctr.tracks t
      UNION ALL
      SELECT 'track', t.name, l.href,
             (SELECT slug FROM ctr.sites WHERE id = t.site_id)
        FROM ctr.track_links l JOIN ctr.tracks t ON t.id = l.track_id
    `,

    // `fields` and `sections` stay JSONB on purpose — a form definition is
    // written and read as one atomic unit — so a URL pasted into a question's
    // help text is inside a document and has to be matched as text.
    sql`SELECT f.name, si.slug AS site,
                  f.fields::text || ' ' || f.sections::text AS blob
             FROM ctr.forms f JOIN ctr.sites si ON si.id = f.site_id`,

    /*
     * An article is both shapes at once: `cover_image` is a plain column and
     * `body` is a document holding every picture dropped into the middle of the
     * text. Both go into one blob and are matched in memory, because the body has
     * to be and splitting them would be two queries to answer one question.
     *
     * Unlike the three documents above, this one is FILTERED in SQL first. An
     * article body is far larger than a section's, and there is no reason to pull
     * the complete text of every article ever written in order to report on the
     * handful that mention these keys.
     */
    sql`SELECT a.title, si.slug AS site,
               coalesce(a.cover_image, '') || ' ' || a.body::text AS blob
          FROM ctr.articles a JOIN ctr.sites si ON si.id = a.site_id
         WHERE EXISTS (SELECT 1 FROM unnest(${wanted}::text[]) AS k(key)
                        WHERE position(k.key in coalesce(a.cover_image, '')) > 0
                           OR position(k.key in a.body::text) > 0)`,

    /*
     * An event, which is an article's two shapes again: a cover column and a
     * report holding whatever pictures were dropped into it. Filtered in SQL for
     * the same reason — no point pulling the whole season's writing to report on
     * the one weekend that mentions these keys.
     *
     * The name is whichever of its title, its circuit or its venue it has, which
     * is the same fallback the calendar card prints. An event headed only by its
     * circuit would otherwise show in the media library as an empty label.
     */
    sql`SELECT coalesce(nullif(e.title, ''), t.name, nullif(e.venue, ''), '') AS title,
               si.slug AS site,
               coalesce(e.cover_image, '') || ' ' || e.body::text AS blob
          FROM ctr.events e
          JOIN ctr.sites si ON si.id = e.site_id
          LEFT JOIN ctr.tracks t ON t.id = e.track_id
         WHERE EXISTS (SELECT 1 FROM unnest(${wanted}::text[]) AS k(key)
                        WHERE position(k.key in coalesce(e.cover_image, '')) > 0
                           OR position(k.key in e.body::text) > 0)`,

    /*
     * A season is a cover and nothing else. It was missing from this scan
     * until the storage move found one season's cover as the last address on
     * the old host — the same omission that let a season's picture be deleted
     * out from under it without a warning.
     */
    sql`SELECT s.name, si.slug AS site, coalesce(s.cover_image, '') AS blob
          FROM ctr.seasons s
          JOIN ctr.sites si ON si.id = s.site_id
         WHERE EXISTS (SELECT 1 FROM unnest(${wanted}::text[]) AS k(key)
                        WHERE position(k.key in coalesce(s.cover_image, '')) > 0)`,
  ]);

  const sectionRows = sections as {
    site: string; site_name: string; type: string; blob: string;
  }[];
  const formRows = documents as { name: string; site: string; blob: string }[];

  if (!warned && (sectionRows.length > TOO_MANY || formRows.length > TOO_MANY)) {
    warned = true;
    console.warn(
      "[media] the usage scan pulls these tables into memory and they have grown past " +
        `${TOO_MANY} rows. Switch it to a per-key query.`
    );
  }

  const usage = new Map<string, UsageRef[]>(wanted.map((key) => [key, []]));

  const add = (key: string, ref: UsageRef): void => {
    const refs = usage.get(key);
    if (!refs) return;
    // One reference per place, however many times that place mentions it: a
    // deck listing the same image on three pages is one deck to the reader.
    if (!refs.some((seen) => seen.kind === ref.kind && seen.label === ref.label)) refs.push(ref);
  };

  /** The documents, matched in memory — the part that has to be. */
  const scan = (blob: unknown, ref: (key: string) => UsageRef): void => {
    const text = typeof blob === "string" ? blob : "";
    if (!text) return;

    for (let index = 0; index < wanted.length; index += 1) {
      if (text.includes(wanted[index]) || text.includes(encoded[index])) {
        add(wanted[index], ref(wanted[index]));
      }
    }
  };

  for (const row of sectionRows) {
    scan(row.blob, () => ({
      kind: "content",
      label: `${row.site_name} — ${row.type}`,
      site: row.site,
    }));
  }

  // A form belongs to a site now — migration 0014 gave it one — so unlike
  // before there IS somebody who can be said to own it, and a sport admin can
  // override a warning about their own form without having to fetch an owner.
  for (const row of formRows) {
    scan(row.blob, () => ({ kind: "form", label: `Form: ${row.name}`, site: row.site }));
  }

  /*
   * Every article belongs to exactly one site now. The old NULL — "written for
   * every page, overridable by an owner alone" — has no equivalent and needs
   * none: migration 0014 gave those articles the root site.
   */
  for (const row of articles as { title: string; site: string; blob: string }[]) {
    scan(row.blob, () => ({
      kind: "article",
      label: `Article: ${row.title || "Untitled"}`,
      site: row.site,
    }));
  }

  for (const row of events as { title: string; site: string; blob: string }[]) {
    scan(row.blob, () => ({
      kind: "event",
      label: `Event: ${row.title || "Untitled"}`,
      site: row.site,
    }));
  }

  for (const row of seasons as { name: string; site: string; blob: string }[]) {
    scan(row.blob, () => ({
      kind: "season",
      label: `Season: ${row.name || "Untitled"}`,
      site: row.site,
    }));
  }

  for (const row of columns as {
    kind: string; label: string; blob: string; site: string | null;
  }[]) {
    scan(row.blob, () => ({
      kind: row.kind === "sport" ? "sport" : "track",
      label: `${row.kind === "sport" ? "Sport" : "Circuit"}: ${row.label}`,
      // A sports card is edited on the root site's own screen; a circuit
      // belongs to the sport that races on it.
      site: row.site,
    }));
  }

  /** The exact-match rows: the database already decided, so just attribute them. */
  const attribute = (
    rows: unknown[],
    urlOf: (row: never) => string,
    ref: (row: never) => UsageRef
  ): void => {
    for (const row of rows as never[]) {
      const url = urlOf(row);
      for (const key of wanted) {
        if (url.includes(key) || url.includes(encodeURI(key))) add(key, ref(row));
      }
    }
  };

  attribute(
    banners as unknown[],
    (row: { url: string }) => row.url,
    (row: { site: string; site_name: string }) => ({
      kind: "content",
      label: `${row.site_name} — banner`,
      site: row.site,
    })
  );
  attribute(
    posts as unknown[],
    (row: { url: string }) => row.url,
    (row: { site: string; site_name: string }) => ({
      kind: "content",
      label: `${row.site_name} — newsroom`,
      site: row.site,
    })
  );
  attribute(
    partners as unknown[],
    (row: { url: string }) => row.url,
    (row: { site: string; site_name: string }) => ({
      kind: "content",
      label: `${row.site_name} — partners`,
      site: row.site,
    })
  );
  attribute(
    deckPages as unknown[],
    (row: { url: string }) => row.url,
    (row: { name: string; site: string }) => ({
      kind: "deck",
      label: `Deck: ${row.name}`,
      site: row.site,
    })
  );

  /*
   * The source pins go on last and are checked FIRST by the delete route, so
   * turning them into a hard refusal later is one `if` rather than a rewrite.
   */
  const pinned = sourcePinnedKeys();
  for (const key of wanted) {
    if (pinned.has(key)) {
      // No site owns the source. Only an owner could ever override this one,
      // which is the right answer for a file the code itself depends on.
      add(key, { kind: "source", label: "Built into the code (src/config/images.ts)", site: null });
    }
  }

  return wanted.map((key) => ({ key, refs: usage.get(key) ?? [] }));
}
