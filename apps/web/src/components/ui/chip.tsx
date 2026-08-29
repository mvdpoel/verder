import type { ReactNode } from "react";
import { cx } from "./cx";

/** Status labels. `solid` is for exactly one thing per screen; the rest are outlines. */
export type ChipTone = "attn" | "signal" | "okay" | "mute" | "faint" | "solid";

const TONE: Record<ChipTone, string> = {
  attn: "text-attn border-attn/40",
  signal: "text-signal border-signal/35",
  okay: "text-okay border-okay/35",
  mute: "text-ink-mute border-edge-strong",
  faint: "text-ink-dim border-edge",
  solid: "text-on-signal border-transparent bg-signal",
};

export function Chip({ tone = "faint", className, children }: {
  tone?: ChipTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-chip border px-[9px] py-[4px]",
        "font-mono text-[9.5px] tracking-[0.14em] uppercase",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
