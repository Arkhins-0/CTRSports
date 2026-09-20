import {
  BODY_MAX,
  hexColour,
  image,
  isRecord,
  isoDate,
  link,
  list,
  oneOf,
  optionalText,
  text,
  withIds,
} from "@/lib/normalise";
import type { SectionModule } from "@/lib/sections/types";

/**
 * Which of black and white the card wears.
 *
 * `auto` is the answer almost always: it reads the card's own colour and picks
 * the legible one, so a colour nobody has thought about still comes out
 * readable. The other two are for the case the design wants and the maths does
 * not — a colour close enough to the crossover that either would pass.
 */
export const ANNOUNCEMENT_INKS = ["auto", "dark", "light"] as const;
export type AnnouncementInk = (typeof ANNOUNCEMENT_INKS)[number];

/**
 * The colour a new announcement starts as: the accent, written out.
 *
 * A Tailwind token cannot be the value of an `<input type="color">` and cannot
 * be measured for contrast, so this one colour exists twice — here and in
 * tailwind.config.ts. It is the only place in the project where that is true,
 * and it is the price of letting the colour be chosen at all.
 */
export const DEFAULT_ANNOUNCEMENT_COLOUR = "#F7D619";

/** How many cards one band may hold. */
export const MAX_ANNOUNCEMENTS = 50;

/** How long each card holds before the next one, in milliseconds. */
export const ANNOUNCEMENT_INTERVAL = 5000;

/**
 * One card, high on the page, pointing at one thing worth interrupting for.
 *
 * ── Why the link is ONE field ────────────────────────────────────
 *
 * `href` is an article, a deck, or an address somebody typed, and there is no
 * enum beside it saying which. The renderer reads that back out of the address
 * itself — `slugFromArticleHref` and `slugFromDeckHref` — so the two can never
 * disagree about what this card points at, which a stored `target` plus a stored
 * slug eventually would.
 *
 * Storing the resolved path rather than an id is the choice `FormPicker`
 * documents at length: this value is normalised in the BROWSER as well as on the
 * server, where nothing can be looked up. What it costs is a rename, and that is
 * paid for elsewhere — both the article and the deck route permanently redirect
 * from a former address.
 *
 * ── The three overrides ─────────────────────────────────────────
 *
 * `image`, `ctaLabel` and `date` are blank almost always. Blank means "take it
 * from the thing this points at" — the article's cover, its title, its published
 * date — so an article renamed or re-photographed on its own screen corrects
 * this card without anyone opening the page. Fill one in only when the page
 * needs to say something the article does not.
 */
export type AnnouncementCard = {
  /** Stable across a save, so a repeater row does not swap places as you type. */
  id: string;
  kicker: string;
  title: string;
  body: string;
  /** The picture on the left. Blank uses the article's or deck's cover. */
  image: string;
  imageAlt: string;
  /** `#RRGGBB`. The card. */
  colour: string;
  ink: AnnouncementInk;
  /** An article, a deck, or anywhere else worth sending someone. */
  href: string;
  /** Printed before the label. Blank prints nothing, which most cards want. */
  emoji: string;
  /** Overrides the button's words. Blank uses the article's or deck's name. */
  ctaLabel: string;
  /** ISO `YYYY-MM-DD`, overriding the article's own date. Blank hides the chip. */
  date: string;
};

/**
 * The band: the cards, shown one at a time.
 *
 * ── Why a list rather than more sections ──────────────────────────────────
 *
 * This section is `multiple`, so a page could always carry several of these —
 * and that is still the right way to put two announcements in two DIFFERENT
 * places. What it could not do is put two in the SAME place. Stacked, the second
 * card pushes the page down and the third makes a wall of colour where the
 * design wanted one interruption, and the reader scrolls past all of them.
 *
 * A list in one band is the other arrangement: one card's worth of page, however
 * many things there are to say, each getting the whole of it in turn. That is a
 * property of the band rather than of the page, which is why it lives here and
 * not in the number of sections somebody added.
 */
export type Announcement = { items: AnnouncementCard[] };

/** A new card. The id is the caller's — only it knows what is unique. */
export const BLANK_ANNOUNCEMENT_CARD: Omit<AnnouncementCard, "id"> = {
  kicker: "",
  title: "",
  body: "",
  image: "",
  imageAlt: "",
  // A real colour rather than "": the card paints this into a style attribute
  // with nothing to fall back to, and an unpainted card is a white rectangle in
  // the middle of a near-black page.
  colour: DEFAULT_ANNOUNCEMENT_COLOUR,
  ink: "auto",
  href: "",
  emoji: "",
  ctaLabel: "",
  date: "",
};

/**
 * The fields ONE card carries, used only to recognise a document written before
 * this band held a list. See `normalise`.
 */
const CARD_KEYS = Object.keys(BLANK_ANNOUNCEMENT_CARD);

function card(entry: Record<string, unknown>): AnnouncementCard {
  const d = BLANK_ANNOUNCEMENT_CARD;

  return {
    id: optionalText(entry.id, 64),
    kicker: text(entry.kicker, d.kicker),
    title: text(entry.title, d.title),
    body: text(entry.body, d.body, BODY_MAX),
    // "" rather than a placeholder, unlike every other picture. Blank here is
    // not "no picture", it is "use the article's" — and a placeholder would be
    // indistinguishable from a real choice, so the fallback in the renderer
    // could never fire.
    image: image(entry.image, ""),
    imageAlt: text(entry.imageAlt, d.imageAlt),
    colour: hexColour(entry.colour, DEFAULT_ANNOUNCEMENT_COLOUR),
    ink: oneOf(entry.ink, ANNOUNCEMENT_INKS, "auto"),
    // "" rather than "#": a card pointing nowhere should draw no button, not a
    // button that scrolls to the top of the page.
    href: link(entry.href, ""),
    // Free text, where every other glyph comes from a closed set drawn by a
    // component. It is an emoji rather than an icon because that is what was
    // asked for — the system font draws it, so there is nothing to ship — and
    // 12 characters is room for a zero-width-joiner sequence without being
    // room for a sentence.
    emoji: optionalText(entry.emoji, 12),
    ctaLabel: text(entry.ctaLabel, d.ctaLabel, 60),
    date: isoDate(entry.date),
  };
}

export const announcement: SectionModule<Announcement> = {
  type: "announcement",
  label: "Announcement",
  hint: "Cards for the things worth interrupting for, shown one at a time — an article, a deck, or anywhere else.",
  surface: ["home"],
  multiple: true,
  anchor: "announcement",
  blank: () => ({ items: [] }),
  normalise: (raw) => {
    const value = isRecord(raw) ? raw : {};

    /*
     * A document saved before this band held a list IS one card, stored flat —
     * `{ kicker, title, colour, … }` with no `items` anywhere in it. Reading
     * that as an empty list would take every announcement on every live page
     * off the site on the next deploy, so it is recognised and read as a list
     * of one instead.
     *
     * Recognised by its KEYS rather than by the absence of `items`, because
     * those are two different documents: `{}` is a band somebody has just added
     * and left empty, and that one really is a list of nothing.
     *
     * There is no migration to write. `normalise` runs on write as well as on
     * read, so the first save of a page rewrites its old card into the new
     * shape, and until then it simply reads correctly.
     */
    const stored = Array.isArray(value.items)
      ? value.items
      : CARD_KEYS.some((key) => key in value)
        ? [value]
        : [];

    return {
      items: withIds(list(stored, MAX_ANNOUNCEMENTS, card, []), "announcement"),
    };
  },
};
