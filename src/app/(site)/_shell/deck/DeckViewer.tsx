"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { pageAlt, type Deck } from "@/lib/decks";
import { cn } from "@/lib/utils";
import { Media } from "@/components/ui/Media";
import { DeckPages } from "./DeckPages";

/**
 * A deck, read one of two ways, with the switch between them above it.
 *
 *   scroll   every page one below another — the PDF-like reading that the deck
 *            was built for. Drawn by `DeckPages`, unchanged.
 *   swipe    one page at a time, filling the width, and the next one a swipe
 *            to the right away. Arrows either side for a mouse, the keyboard's
 *            arrow keys, and a "3 / 12" counter so nobody wonders how far in
 *            they are.
 *
 * ── Why this is a client component and `DeckPages` is not ─────────────────
 *
 * The switch is state, and the carousel needs to know where it has been
 * scrolled to. `DeckPages` is left as the plain server-renderable thing it was
 * so the admin's preview can go on drawing it exactly as the public page does.
 *
 * ── How the swipe is built ────────────────────────────────────────────────
 *
 * CSS scroll-snap on a horizontal overflow, not a transform driven by pointer
 * maths. The browser's own scroll physics are the swipe people already know
 * from their photo app — the momentum, the rubber-band, the way a half-hearted
 * flick settles back — and every hand-rolled version of that is a worse copy.
 * The arrows just call `scrollTo`, and the counter reads back which page the
 * snap landed on.
 *
 * The choice is remembered in localStorage, because somebody who reads decks
 * by swiping will open the next one the same way; it is a convenience, so any
 * failure to read or write it is swallowed and the default wins.
 */

type ViewMode = "scroll" | "swipe";

const STORAGE_KEY = "deck-view";

function readStoredMode(): ViewMode | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "scroll" || value === "swipe" ? value : null;
  } catch {
    return null;
  }
}

function storeMode(mode: ViewMode) {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* A private window, or storage blocked. The switch still works for this visit. */
  }
}

export function DeckViewer({ deck, className }: { deck: Deck; className?: string }) {
  const [mode, setMode] = useState<ViewMode>("scroll");

  // Read after mount, so the server's markup and the first client render agree
  // and the switch does not flash from one setting to the other on hydration.
  useEffect(() => {
    const stored = readStoredMode();
    if (stored) setMode(stored);
  }, []);

  function choose(next: ViewMode) {
    setMode(next);
    storeMode(next);
  }

  if (deck.pages.length === 0) return null;

  return (
    <div className={cn("mx-auto w-full max-w-4xl", className)}>
      <div
        role="group"
        aria-label="How to read this deck"
        className="mb-4 flex items-center justify-end gap-1 sm:mb-5"
      >
        <ModeButton active={mode === "scroll"} onClick={() => choose("scroll")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M12 4v16m0 0-4-4m4 4 4-4"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Scroll
        </ModeButton>

        <ModeButton active={mode === "swipe"} onClick={() => choose("swipe")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M4 12h16m0 0-4-4m4 4-4 4"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Swipe
        </ModeButton>
      </div>

      {mode === "swipe" ? <SwipeDeck deck={deck} /> : <DeckPages deck={deck} />}
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[12px] font-semibold tracking-wide transition",
        active
          ? "border-accent bg-accent text-accent-ink"
          : "border-line text-fg-muted hover:border-accent hover:text-accent"
      )}
    >
      {children}
    </button>
  );
}

/* ───────────────────────────── The carousel ─────────────────────────── */

function SwipeDeck({ deck }: { deck: Deck }) {
  const track = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const count = deck.pages.length;

  /*
   * Which page the scroll has settled on. Rounded from the offset rather than
   * taken from an IntersectionObserver, because there is exactly one page per
   * viewport width and the arithmetic is both simpler and never off by one at
   * the edges. Read on `scroll` so the counter follows a finger in real time.
   */
  const onScroll = useCallback(() => {
    const element = track.current;
    if (!element || element.clientWidth === 0) return;
    const next = Math.round(element.scrollLeft / element.clientWidth);
    setIndex(Math.max(0, Math.min(count - 1, next)));
  }, [count]);

  const goTo = useCallback(
    (target: number) => {
      const element = track.current;
      if (!element) return;
      const clamped = Math.max(0, Math.min(count - 1, target));
      element.scrollTo({ left: clamped * element.clientWidth, behavior: "smooth" });
    },
    [count]
  );

  // Arrow keys, while the carousel, its arrows or anything in them has focus.
  // Bound on the wrapper rather than the document: a visitor tabbing through
  // the footer should not have the deck turn pages under them.
  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      goTo(index + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      goTo(index - 1);
    }
  }

  // A resize changes the width every page is measured against, so the scroll
  // offset that meant "page 4" now means something else. Put it back.
  useEffect(() => {
    const element = track.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      element.scrollTo({ left: index * element.clientWidth });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [index]);

  return (
    <div className="relative" onKeyDown={onKeyDown}>
      <div
        ref={track}
        onScroll={onScroll}
        tabIndex={0}
        role="region"
        aria-roledescription="carousel"
        aria-label={deck.name || "Deck"}
        // `rail-scroll` hides the bar; the pages ARE the scroll position, and a
        // bar under them says "there is more" in a way the counter says better.
        className="rail-scroll flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain rounded-[6px] bg-panel focus-visible:outline-none"
      >
        {deck.pages.map((page, index) => (
          <div
            key={`${index}-${page.url}`}
            role="group"
            aria-roledescription="slide"
            aria-label={`${index + 1} of ${count}`}
            className="relative w-full shrink-0 snap-center"
          >
            <Media
              src={page.url}
              alt={pageAlt(deck, page, index)}
              // The current, the one either side, then lazily: a swipe should
              // never land on a grey box, and the rest can arrive as they are
              // approached.
              loading={index < 3 ? "eager" : "lazy"}
              decoding="async"
              draggable={false}
              controls
              className="block h-auto w-full select-none"
            />
          </div>
        ))}
      </div>

      {count > 1 ? (
        <>
          <ArrowButton
            side="left"
            label="Previous page"
            disabled={index === 0}
            onClick={() => goTo(index - 1)}
          />
          <ArrowButton
            side="right"
            label="Next page"
            disabled={index === count - 1}
            onClick={() => goTo(index + 1)}
          />

          <p
            aria-live="polite"
            className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-white/15 bg-black/60 px-3 py-1 text-[12px] font-semibold tabular-nums text-white/90 backdrop-blur"
          >
            {index + 1} / {count}
          </p>
        </>
      ) : null}
    </div>
  );
}

function ArrowButton({
  side,
  label,
  disabled,
  onClick,
}: {
  side: "left" | "right";
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={cn(
        "absolute top-1/2 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-black/60 text-white backdrop-blur transition sm:flex",
        "enabled:hover:border-accent enabled:hover:text-accent disabled:opacity-30",
        side === "left" ? "left-3" : "right-3"
      )}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d={side === "left" ? "m15 5-7 7 7 7" : "m9 5 7 7-7 7"}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
