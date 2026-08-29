import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

/**
 * The glass panel — the only box in this system. `.panel` lives in globals.css
 * because the gradient and the two-tone border do not write themselves sanely as
 * separate utilities.
 *
 * `lit` turns on the light streak along the top edge. That is for the panel that
 * LEADS the page — one per screen. On everything it stops being an accent and
 * becomes wallpaper.
 */
export function Panel({
  lit = false,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { lit?: boolean }) {
  return (
    <div className={cx("panel overflow-hidden", lit && "panel-edge", className)} {...rest}>
      {children}
    </div>
  );
}

/** The small caps label above a block. */
export function Label({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("lbl", className)}>{children}</div>;
}

/** Mono micro: dates, channels, statuses — everything that has been measured. */
export function Micro({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("micro", className)}>{children}</div>;
}

/**
 * A panel's head: label left, the way onward right. Same height everywhere, so
 * panels sitting next to each other start on one line.
 */
export function PanelHead({ label, aside }: { label: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between">
      <Label>{label}</Label>
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
