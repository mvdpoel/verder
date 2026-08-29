import type { ButtonHTMLAttributes } from "react";
import { cx } from "./cx";

/**
 * The system's buttons.
 *
 * `primary` is the only one carrying the cyan gradient and the glow, and there
 * should be ONE per screen: the glow is a signal ("press here"), and two glowing
 * buttons side by side say nothing at all.
 *
 * `signal` is the affirmative button on a screen that has NO single primary —
 * a list of cards where every card carries the same decision. It is cyan text
 * on a cyan outline: the system's own colour, so it still reads as "this is the
 * one", but no gradient and no glow, so ten of them on one page cost nothing.
 * Without it a repeated affirmative had to be `primary`, and /queue rendered a
 * glow per suggestion — which is exactly the law that glow is a signal and not
 * decoration, broken by the page that needed it most.
 *
 * `danger` is amber with a border, never filled. Amber is reserved for "this is
 * waiting on you"; a solid amber slab would compete with that marker on the map,
 * while a thin border carries exactly the hesitation something you only want to
 * do on purpose deserves.
 */
export type ButtonVariant = "primary" | "signal" | "ghost" | "quiet" | "danger";
export type ButtonSize = "md" | "sm";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "text-on-signal grad-action shadow-action hover:brightness-110",
  signal: "text-signal border border-signal/40 hover:border-signal/75 hover:text-signal-link",
  ghost: "text-ink-soft border border-edge-strong hover:border-signal/50 hover:text-ink-bright",
  quiet: "text-ink-dim hover:text-ink-soft",
  danger: "text-attn border border-attn/35 hover:border-attn/70",
};

const SIZE: Record<ButtonSize, string> = {
  md: "text-[11px] px-[22px] py-[13px]",
  sm: "text-[10px] px-[14px] py-[9px]",
};

/**
 * The class factory on its own, so a `<Link>` can look exactly like a button
 * without a button being nested inside a link.
 */
export function buttonClass(
  variant: ButtonVariant = "ghost",
  size: ButtonSize = "md",
  extra?: string,
): string {
  return cx(
    "inline-flex items-center justify-center gap-[10px] rounded-chip font-mono tracking-[0.16em] uppercase",
    "transition-colors disabled:opacity-40 disabled:pointer-events-none",
    VARIANT[variant],
    SIZE[size],
    extra,
  );
}

export function Button({
  variant = "ghost",
  size = "md",
  className,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return <button type={type} className={buttonClass(variant, size, className)} {...rest} />;
}
