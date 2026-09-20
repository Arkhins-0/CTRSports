"use client";

import {
  articleDate,
  slugFromArticleHref,
  type ArticleSummary,
} from "@/lib/articles";
import { readableInk } from "@/lib/colour";
import { slugFromDeckHref, type DeckSummary } from "@/lib/decks";
import {
  ANNOUNCEMENT_INKS,
  ANNOUNCEMENT_INTERVAL,
  BLANK_ANNOUNCEMENT_CARD,
  DEFAULT_ANNOUNCEMENT_COLOUR,
  MAX_ANNOUNCEMENTS,
  type Announcement,
  type AnnouncementCard,
  type AnnouncementInk,
} from "./model";
import { hexColour } from "@/lib/normalise";
import type { SiteRef } from "@/lib/sites";
import { Button } from "@/admin/ui/Button";
import { Label } from "@/admin/ui/Input";
import { ColourField } from "@/admin/components/ColourField";
import { Field, Hint, Row, TextArea } from "@/admin/components/Fields";
import { ImageField } from "@/admin/components/ImageField";
import { LinkPicker } from "@/admin/components/LinkPicker";
import { Repeater } from "@/admin/components/Repeater";
import type { SectionPanelProps } from "@/lib/sections/types";

const INK_LABELS: Record<AnnouncementInk, string> = {
  auto: "Auto",
  dark: "Black",
  light: "White",
};

/**
 * The cards at the top of the page, and the only section whose colour is chosen
 * rather than designed.
 *
 * ── Why a repeater, and why the dialog shape ──────────────────────────────
 *
 * A card is eleven fields with a picture, a colour and a link in it. In the
 * always-open shape that is a column nobody can scan, and in the accordion it is
 * a strip that unfolds past the bottom of the screen. So each card is one line
 * that opens in a window — the same call the posts band makes, and for the same
 * reason.
 *
 * ── Why the placeholders are worth the code ───────────────────────────────
 *
 * Three of a card's fields are OVERRIDES and the panel has to say so, because a
 * blank field that means "take it from the article" is indistinguishable from a
 * blank field that means "leave it off" unless something tells you. So the
 * picture, the button's words and the date all show what they would fall back to
 * as their placeholder — the article's own cover, title and date, resolved here
 * the same way the page resolves them.
 */
export function AnnouncementPanel({ value, onChange, ctx }: SectionPanelProps<Announcement>) {
  const { articles, decks, site } = ctx.records;

  return (
    <Repeater<AnnouncementCard>
      title="Announcements"
      addLabel="Add announcement"
      items={value.items}
      max={MAX_ANNOUNCEMENTS}
      onChange={(items) => onChange({ ...value, items })}
      blank={() => ({ id: crypto.randomUUID(), ...BLANK_ANNOUNCEMENT_CARD })}
      keyOf={(item) => item.id}
      summary={(card, index) => {
        const { article, deck } = pointsAt(site, card, articles, decks);

        return {
          title: card.title || article?.title || deck?.name || `Announcement ${index + 1}`,
          hint: card.kicker,
          // The inherited cover too, not only the typed one: a row whose
          // thumbnail is empty while the page draws a picture is a row that
          // tells you the wrong thing.
          image: card.image || article?.cover_image || deck?.cover || "",
        };
      }}
      empty="No announcements — the whole band is left off the page."
      note={
        <>
          One card at a time, each holding for {Math.round(ANNOUNCEMENT_INTERVAL / 1000)} seconds
          before the next, and the band pauses while somebody is reading it or reaching for its
          button. With one card there is nothing to rotate and no dots are drawn. A card points at
          an article, a deck, or anywhere you type — and takes the picture, the wording and the
          date from whatever it points at, so renaming an article on its own screen corrects the
          card too. A link starting <code>http</code> opens in a new tab. A card with nothing
          written in it is left out, so it costs neither a turn nor a dot.
        </>
      }
    >
      {(card, index, patch) => (
        <CardFields
          card={card}
          patch={patch}
          site={site}
          articles={articles}
          decks={decks}
        />
      )}
    </Repeater>
  );
}

/* ─────────────────────────── One card's fields ──────────────────────── */

function CardFields({
  card,
  patch,
  site,
  articles,
  decks,
}: {
  card: AnnouncementCard;
  patch: (patch: Partial<AnnouncementCard>) => void;
  site: SiteRef;
  articles: ArticleSummary[];
  decks: DeckSummary[];
}) {
  // The same resolution the band does, so the placeholders below promise exactly
  // what the page will draw.
  const { article, deck } = pointsAt(site, card, articles, decks);

  const inheritedLabel = article?.title || deck?.name || "";
  const inheritedDate = article?.published_at ?? "";

  const settledColour = hexColour(card.colour, DEFAULT_ANNOUNCEMENT_COLOUR);
  const automatic = readableInk(settledColour);

  return (
    <>
      {/*
        First, not last. Choosing what the card points at is the decision that
        can fill everything below it, so it belongs above the fields it fills.
      */}
      <LinkPicker
        label="Goes to"
        value={card.href}
        onChange={(href) => patch({ href })}
        articles={articles}
        decks={decks}
      />

      <Field
        label="Kicker"
        value={card.kicker}
        onChange={(kicker) => patch({ kicker })}
        hint="The outlined chip at the top. Blank hides it."
      />
      <Field label="Title" value={card.title} onChange={(title) => patch({ title })} />
      <TextArea label="Body" value={card.body} onChange={(body) => patch({ body })} rows={3} />

      <ImageField
        label="Picture"
        value={card.image}
        onChange={(image) => patch({ image })}
        hint={
          article?.cover_image
            ? "Blank uses the article's own cover, which is usually what you want."
            : deck?.cover
              ? "Blank uses the deck's first page."
              : "Sits to the left of the words. Blank drops the column entirely."
        }
      />
      <Field
        label="Picture description"
        value={card.imageAlt}
        onChange={(imageAlt) => patch({ imageAlt })}
        hint="What the picture shows, for anyone who cannot see it."
      />

      <ColourField
        label="Card"
        value={card.colour}
        onChange={(colour) => patch({ colour })}
        fallback={DEFAULT_ANNOUNCEMENT_COLOUR}
        hint="The whole card, and its dot in the strip below the band. This is the one thing on the page that is not from the palette, so it is also the one that can be made unreadable."
      />

      <div>
        <Label>Words</Label>
        <div className="mt-1.5 grid grid-cols-3 gap-1.5">
          {ANNOUNCEMENT_INKS.map((ink) => (
            <Button
              key={ink}
              variant={card.ink === ink ? "default" : "outline"}
              size="sm"
              onClick={() => patch({ ink })}
              aria-pressed={card.ink === ink}
            >
              {INK_LABELS[ink]}
            </Button>
          ))}
        </div>
        <Hint className="mt-1">
          {card.ink === "auto" ? (
            <>
              Measured off the colour, and it has chosen{" "}
              <span className="text-foreground">{automatic === "dark" ? "black" : "white"}</span>.
              Leave it here unless you disagree.
            </>
          ) : card.ink === automatic ? (
            "The same as Auto would have picked — Auto keeps it right if the colour changes."
          ) : (
            <span className="text-destructive">
              Auto would have picked {automatic === "dark" ? "black" : "white"} on this colour.
              Check it is still readable.
            </span>
          )}
        </Hint>
      </div>

      <Row>
        <Field
          label="Emoji"
          value={card.emoji}
          onChange={(emoji) => patch({ emoji })}
          maxLength={12}
          placeholder="🏁"
          hint="Before the words. Blank prints none."
        />
        <Field
          label="Date on the chip"
          value={card.date}
          onChange={(date) => patch({ date })}
          placeholder={inheritedDate || "YYYY-MM-DD"}
          hint={inheritedDate ? `Blank uses ${articleDate(inheritedDate)}.` : "Blank hides the chip."}
        />
      </Row>

      <Field
        label="Button"
        value={card.ctaLabel}
        onChange={(ctaLabel) => patch({ ctaLabel })}
        maxLength={60}
        placeholder={inheritedLabel || "Blank hides the button"}
        hint={
          inheritedLabel
            ? "Blank uses its own name, which is what you want unless this page calls it something else."
            : "With nothing to take a name from, a blank button is no button."
        }
      />
    </>
  );
}

/* ───────────────────────────── Resolution ───────────────────────────── */

/**
 * What a card points at, if it is one of ours.
 *
 * The same two lookups the band makes, in one place because the summary line and
 * the fields both need them and a second copy is a second thing to drift.
 */
function pointsAt(
  site: SiteRef,
  card: AnnouncementCard,
  articles: ArticleSummary[],
  decks: DeckSummary[]
) {
  const articleSlug = slugFromArticleHref(site, card.href);
  const deckSlug = slugFromDeckHref(site, card.href);

  return {
    article: articleSlug ? articles.find((entry) => entry.slug === articleSlug) : undefined,
    deck: deckSlug ? decks.find((entry) => entry.slug === deckSlug) : undefined,
  };
}
