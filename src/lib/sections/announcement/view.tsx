"use client";

import { useEffect, useMemo, useState } from "react";
import { articleDate, slugFromArticleHref } from "@/lib/articles";
import { readableInk } from "@/lib/colour";
import { slugFromDeckHref } from "@/lib/decks";
import type { SectionRecords, SectionViewProps } from "@/lib/sections/types";
import { ANNOUNCEMENT_INTERVAL, type Announcement, type AnnouncementCard } from "./model";
import { cn } from "@/lib/utils";
import { ArrowIcon } from "@/components/ui/ActionButton";
import { Reveal } from "@/components/ui/Reveal";
import { Media } from "@/components/ui/Media";
import { usePreviewMode } from "@/components/ui/PreviewMode";

/**
 * The things worth interrupting for, at the top of the page, one at a time.
 *
 * The register band's treatment — a flat coloured rectangle with a soft wash off
 * one corner — with two differences that are the whole point of it. The colour
 * is chosen per announcement rather than fixed to the accent, and the card is
 * two columns: the picture on the left, the words and the button on the right.
 *
 * ── Why the colour is inline and the type is not ──────────────────────────
 *
 * A colour that is typed cannot be a utility class: Tailwind's stylesheet is
 * built from the source, so a class assembled from a variable is not in it. The
 * background therefore goes in a `style` attribute, and `hexColour` is what
 * makes that safe — nothing reaches this component that is not six hex digits.
 *
 * The TYPE is still classes, because there are only ever two of them. `auto`
 * measures the colour and picks the readable one; the other two are the
 * editor overruling that.
 *
 * ── Why this draws its own button ─────────────────────────────────────────
 *
 * ActionButton says in its own header to resist a fourth variant, and it is
 * right: its three are the site's button vocabulary and a per-card colour is not
 * a variant, it is a value. So the pill below is drawn here — inverted, ink
 * behind the card's own colour — and imports that file's `ArrowIcon` so the knob
 * is the same knob every other call to action on the site wears.
 *
 * ── Why it is a client component now ──────────────────────────────────────
 *
 * It rotates, and a clock read during a server render is a clock baked into a
 * statically rendered page. Everything it needs is already in its props, so the
 * cost is the component itself rather than any of the data behind it.
 */
export function AnnouncementView({ value: announcement, records }: SectionViewProps<Announcement>) {
  /*
   * Every card resolved against what it points at, and the empty ones dropped.
   *
   * Dropping has to happen HERE rather than inside the card, because it decides
   * the length of the carousel: a blank card that rendered nothing would still
   * take its five seconds and its dot, so the band would go blank once a lap.
   */
  const cards = useMemo(
    () =>
      announcement.items
        .map((card) => resolve(card, records))
        .filter((card): card is Resolved => card !== null),
    [announcement.items, records]
  );

  // Nothing written is no section — the same guard the register band makes, and
  // for the same reason: with no words in it this is not a quiet band, it is the
  // loudest thing on the page saying nothing at all.
  if (cards.length === 0) return null;

  return (
    <section id="announcement" className="shell py-8 sm:py-10">
      <Reveal>
        <Carousel cards={cards} />
      </Reveal>
    </section>
  );
}

/* ──────────────────────────── The rotation ──────────────────────────── */

function Carousel({ cards }: { cards: Resolved[] }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const preview = usePreviewMode();

  // Clamped rather than trusted: a card can be removed while its index is held,
  // which happens on every keystroke in the console's preview.
  const current = Math.min(index, cards.length - 1);

  useEffect(() => {
    /*
     * Nothing to rotate between, somebody is reading it, or this is the
     * console's preview — where a card sliding away mid-edit is the opposite of
     * a preview, so it never advances at all and the dots below are how an
     * editor reaches the card they are working on.
     */
    if (cards.length < 2 || paused || preview) return;

    /*
     * A timeout re-armed per card rather than one repeating interval, which is
     * what makes a dot behave: clicking one changes `current`, this effect tears
     * down and arms again, and the card chosen by hand gets its whole five
     * seconds instead of whatever was left of somebody else's.
     */
    const id = window.setTimeout(
      () => setIndex((current + 1) % cards.length),
      ANNOUNCEMENT_INTERVAL
    );
    return () => window.clearTimeout(id);
  }, [cards.length, current, paused, preview]);

  return (
    <div
      // Held while the pointer or the keyboard is on it: a card carrying a
      // button that slides away as somebody reaches for it is a link they
      // cannot click.
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      {/*
        Every card in the SAME grid cell, so the box is as tall as the tallest
        one and rotating never moves the page under the reader. A card mounted
        only while it shows would collapse the section to each card's own height
        in turn, which at the top of a page throws everything below it around.

        `invisible` rather than `hidden`: visibility keeps the layout — which is
        the whole reason they are all here — and takes the card out of the tab
        order, which `opacity-0` alone would not.
      */}
      <div className="grid">
        {cards.map((entry, position) => (
          <div
            key={entry.card.id}
            className={cn(
              // `visibility` is IN the transition, not just `opacity`. It is
              // discretely animated — held at its old value for the whole
              // duration when turning off, applied at once when turning on —
              // so the outgoing card stays on screen for the crossfade instead
              // of blinking out and leaving the page behind it showing through.
              "col-start-1 row-start-1 transition-[opacity,visibility] duration-500",
              position === current ? "opacity-100" : "invisible opacity-0"
            )}
            aria-hidden={position !== current}
          >
            <Card
              entry={entry}
              // Only the card on show and the one after it carry a real
              // picture; the rest draw the same empty box, which holds exactly
              // the same space because the size comes from the aspect ratio
              // rather than from the file. Fifty cards would otherwise be fifty
              // images fetched to show one, and the next one being loaded
              // already is what makes an ordinary lap seamless.
              picture={position === current || position === (current + 1) % cards.length}
            />
          </div>
        ))}
      </div>

      {cards.length > 1 ? (
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {cards.map((entry, position) => (
            <button
              key={entry.card.id}
              type="button"
              onClick={() => setIndex(position)}
              aria-label={`Show announcement ${position + 1} of ${cards.length}`}
              aria-current={position === current}
              // The active dot wears its own card's colour, so the strip says
              // which of a coloured set is up rather than only how many there
              // are. The rest stay neutral — six accent dots would read as six
              // things needing attention.
              style={position === current ? { backgroundColor: entry.card.colour } : undefined}
              className={cn(
                "h-1.5 rounded-full transition-all",
                position === current ? "w-7" : "w-1.5 bg-fg-faint/40 hover:bg-fg-faint"
              )}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ───────────────────────────── One card ─────────────────────────────── */

function Card({ entry, picture }: { entry: Resolved; picture: boolean }) {
  const { card, image, label, date, dark, offSite } = entry;

  return (
    <div
      style={{ backgroundColor: card.colour }}
      className={cn(
        "relative overflow-hidden rounded-card px-6 py-8 sm:px-10 sm:py-10",
        dark ? "text-black" : "text-white"
      )}
    >
      {/* The register band's corner wash, in whichever ink this card wears —
          a single flat colour is a lot of it at this size. */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full blur-3xl",
          dark ? "bg-black/10" : "bg-white/10"
        )}
      />

      <div
        className={cn(
          "relative grid items-center gap-7 sm:gap-9",
          // No picture drops the column rather than leaving a gap where one
          // would have been.
          image && "md:grid-cols-[minmax(0,0.85fr)_minmax(0,1fr)]"
        )}
      >
        {image ? (
          picture ? (
            <Media
              src={image}
              alt={card.imageAlt}
              loading="lazy"
              decoding="async"
              // A tile rather than the card's own radius: it sits inside the
              // padding, so matching the outer corner would read as a mistake.
              controls
              className="block aspect-[16/10] w-full rounded-panel object-cover"
            />
          ) : (
            // The same box, holding the same space, with nothing fetched into
            // it. See `picture` at the call site.
            <span aria-hidden className="block aspect-[16/10] w-full rounded-panel" />
          )
        ) : null}

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {card.kicker ? (
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.18em]",
                  dark ? "border-black/25" : "border-white/30"
                )}
              >
                {card.kicker}
              </span>
            ) : null}

            {date ? (
              <span
                className={cn(
                  "inline-flex items-center rounded-full px-3.5 py-1.5 text-[11px] font-semibold",
                  dark ? "bg-black/10" : "bg-white/15"
                )}
              >
                {date}
              </span>
            ) : null}
          </div>

          {card.title ? (
            <h2
              className={cn(
                // `headline` carries `text-fg`, which is white and would win
                // over the card's ink on a light colour. The rest of it —
                // the display face, the weight, the tight leading — is what
                // makes this a headline, so it is kept and the colour is
                // stated after it.
                "headline text-[clamp(1.5rem,3vw,2.35rem)]",
                dark ? "text-black" : "text-white",
                (card.kicker || date) && "mt-4"
              )}
            >
              {card.title}
            </h2>
          ) : null}

          {card.body ? (
            <p
              className={cn(
                "max-w-xl text-[15px] leading-relaxed",
                dark ? "text-black/75" : "text-white/75",
                (card.kicker || date || card.title) && "mt-3"
              )}
            >
              {card.body}
            </p>
          ) : null}

          {label && card.href ? (
            <a
              href={card.href}
              target={offSite ? "_blank" : undefined}
              rel={offSite ? "noreferrer" : undefined}
              style={{ color: card.colour }}
              className={cn(
                "group mt-7 inline-flex items-center gap-2.5 rounded-full py-1.5 pl-6 pr-1.5 text-sm font-semibold",
                "transition-all duration-300 hover:-translate-y-0.5 active:translate-y-0",
                dark ? "bg-black hover:bg-black/85" : "bg-white hover:bg-white/90"
              )}
            >
              {card.emoji ? (
                // Presentational: the label beside it already says where
                // this goes, and a screen reader announcing "party popper"
                // in the middle of a button name helps nobody.
                <span aria-hidden>{card.emoji}</span>
              ) : null}
              {label}
              <span
                style={{ backgroundColor: card.colour }}
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                  dark ? "text-black" : "text-white"
                )}
              >
                <ArrowIcon className="transition-transform duration-300 group-hover:translate-x-0.5" />
              </span>
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────── Resolution ────────────────────────────── */

/** One card with everything it inherits already worked out. */
type Resolved = {
  card: AnnouncementCard;
  image: string;
  label: string;
  date: string;
  dark: boolean;
  offSite: boolean;
};

/**
 * What a card actually draws, or `null` when it draws nothing.
 *
 * The resolved label and picture are what decide that, not just the typed ones:
 * a card that only points at an article still has an article's title and cover
 * to show.
 */
function resolve(card: AnnouncementCard, records: SectionRecords): Resolved | null {
  const { articles, decks, site } = records;

  /*
   * What this points at, read out of the address rather than stored beside it.
   * Neither lookup finding anything is not an error — it is a typed link, which
   * is the third thing the picker offers.
   */
  const articleSlug = slugFromArticleHref(site, card.href);
  const deckSlug = slugFromDeckHref(site, card.href);

  const article = articleSlug ? articles.find((entry) => entry.slug === articleSlug) : undefined;
  const deck = deckSlug ? decks.find((entry) => entry.slug === deckSlug) : undefined;

  // The three overrides. Blank takes it from whatever this points at, so an
  // article renamed on its own screen renames this card too.
  const image = card.image || article?.cover_image || deck?.cover || "";
  const label = card.ctaLabel || article?.title || deck?.name || "";
  const date = articleDate(card.date || article?.published_at || "");

  if (!card.kicker && !card.title && !card.body && !label && !image) return null;

  const ink = card.ink === "auto" ? readableInk(card.colour) : card.ink;

  return {
    card,
    image,
    label,
    date,
    dark: ink === "dark",
    // Derived, never stored: an anchor or a path on this site is a move within
    // the page, and a new tab for one of those is a bug rather than a courtesy.
    offSite: card.href.startsWith("http"),
  };
}
