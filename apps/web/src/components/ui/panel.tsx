import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

/**
 * The elements a box in this system is allowed to be. Deliberately a closed
 * list and not `ElementType`: a landmark, a list item or a plain div covers
 * every case on these screens, and anything wider invites a `<Panel as="a">`
 * that would need its own focus and hover behaviour to be honest.
 */
type BoxElement = "div" | "section" | "article" | "aside" | "li";
/** The elements a small-caps label is allowed to be — see `Label`. */
type LabelElement = "div" | "h1" | "h2" | "h3" | "h4" | "legend" | "span";

/**
 * The glass panel — the only box in this system. `.panel` lives in globals.css
 * because the gradient and the two-tone border do not write themselves sanely as
 * separate utilities.
 *
 * `lit` turns on the light streak along the top edge. That is for the panel that
 * LEADS the page — one per screen. On everything it stops being an accent and
 * becomes wallpaper.
 *
 * `as` exists because a panel is very often a landmark: three sections on
 * /money and two blocks on /registry were written as a bare
 * `<section className="panel …">` purely because this component could only be a
 * `<div>`, and a hand-copied `.panel` class is a panel that stops tracking this
 * one the moment the gradient changes.
 */
export function Panel({
  as: Element = "div",
  lit = false,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLElement> & { as?: BoxElement; lit?: boolean }) {
  return (
    <Element className={cx("panel overflow-hidden", lit && "panel-edge", className)} {...rest}>
      {children}
    </Element>
  );
}

/**
 * The small caps label above a block.
 *
 * `as` is what keeps the look and the document outline from being mutually
 * exclusive. Most block titles in this app ARE headings, and a screen reader
 * navigates by them — so before this prop existed every one of them was written
 * as a raw `<h2 className="lbl">` against the globals.css class, which is the
 * same style spelled a second way in twenty files. `as="legend"` covers the
 * fieldset case for the same reason.
 */
export function Label({
  as: Element = "div", className, children,
}: {
  as?: LabelElement;
  className?: string;
  children: ReactNode;
}) {
  return <Element className={cx("lbl", className)}>{children}</Element>;
}

/** Mono micro: dates, channels, statuses — everything that has been measured. */
export function Micro({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("micro", className)}>{children}</div>;
}

/**
 * A panel's head: label left, the way onward right. Same height everywhere, so
 * panels sitting next to each other start on one line.
 */
export function PanelHead({ label, labelAs, aside }: {
  label: ReactNode;
  /** Forwarded to `Label` — a panel's title is usually a real heading. */
  labelAs?: LabelElement;
  aside?: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between">
      <Label as={labelAs}>{label}</Label>
      {aside ? (
        <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-signal">{aside}</div>
      ) : null}
    </div>
  );
}

/**
 * One measurement. The number is mono and large, the unit beside it small — and
 * a number only earns the cyan glow when it points somewhere work is waiting.
 */
export function Stat({
  label,
  value,
  sub,
  tone = "plain",
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "plain" | "signal" | "attn";
}) {
  return (
    <div className="flex flex-col gap-2 bg-void px-[22px] py-[18px]">
      <Label>{label}</Label>
      <div className="flex items-baseline gap-[9px]">
        <div
          className={cx(
            "font-mono text-[32px] leading-none",
            tone === "signal" && "text-signal [text-shadow:0_0_22px_#63d3ea8c]",
            tone === "attn" && "text-attn",
            tone === "plain" && "text-ink",
          )}
        >
          {value}
        </div>
        {sub ? <div className="text-xs text-ink-label">{sub}</div> : null}
      </div>
    </div>
  );
}

/**
 * A row of measurements. The hairline between tiles is the grid's BACKGROUND
 * showing through 1px gaps, not a border per tile: that way there is never a
 * doubled line and the outer edges stay quiet.
 */
export function StatRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("grid gap-px bg-hairline-lit", className)}>{children}</div>;
}
