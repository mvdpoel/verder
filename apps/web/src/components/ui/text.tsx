import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";

/**
 * The page's own title.
 *
 * One size, one weight, one colour, on every screen — which is the entire point:
 * this exact string of five utilities was written out twenty times across twelve
 * areas, and three of those copies had already picked up a different
 * `leading-*`. Anything a screen genuinely needs on top of it (a tighter leading
 * for a two-line entry summary) goes through `className`, so the divergence is
 * visible at the call site instead of hidden in a copied class list.
 *
 * It renders an `<h1>` and takes no `as`: a page has one title, and a screen
 * that wants this look somewhere else wants `Label` instead.
 */
export function PageTitle({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <h1 className={cx("text-[28px] font-extralight tracking-[-0.015em] text-ink-bright", className)}>
      {children}
    </h1>
  );
}

/**
 * A link inside prose.
 *
 * Cyan is the system's own voice and the way onward, and this treatment —
 * cyan brightening to `signal-link` on hover — was spelled out by hand at
 * roughly thirty call sites in fourteen files. `buttonClass` covered the links
 * that look like buttons; nothing covered the ones that look like links.
 *
 * Size and weight stay at the call site (`text-[13.5px] font-light`, the mono
 * micro variants) because they belong to the block the link sits in, not to the
 * link. What must not vary is the colour, and now it cannot.
 */
export function TextLink({ className, ...rest }: ComponentProps<typeof Link>) {
  return <Link className={cx("text-signal transition-colors hover:text-signal-link", className)} {...rest} />;
}
