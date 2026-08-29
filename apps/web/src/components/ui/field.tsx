import type {
  InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes,
} from "react";
import { cx } from "./cx";

/**
 * Input.
 *
 * One shape for everything: label ABOVE the control, help below it, errors in
 * amber. The label is always there — a placeholder standing in for a label
 * disappears the moment you start typing, and then you have a filled-in form
 * with no names on it. In a dossier you re-read months later that is useless.
 *
 * The error line is amber, and it is the ONE exception to "amber means it is
 * waiting on you" — a field that is wrong is literally waiting on you.
 */
const CONTROL = [
  "w-full rounded-chip border border-edge-strong bg-field px-[13px] py-[11px]",
  "font-display text-sm font-light text-ink",
  "focus:border-signal focus:outline-none focus:[box-shadow:0_0_0_1px_#63d3ea40,0_0_20px_-8px_#63d3eacc]",
  "disabled:opacity-45",
].join(" ");

export function Field({
  label, hint, error, htmlFor, className, children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx("flex flex-col gap-[7px]", className)}>
      <label className={cx("lbl", error && "text-attn")} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && !error ? <p className="text-xs font-light text-ink-label">{hint}</p> : null}
      {error ? (
        <p className="font-mono text-[10px] tracking-[0.12em] uppercase text-attn">{error}</p>
      ) : null}
    </div>
  );
}

export function Input({ className, invalid, ...rest }:
  InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input className={cx(CONTROL, invalid && "border-attn/55", className)} {...rest} />;
}

export function Textarea({ className, invalid, rows = 4, ...rest }:
  TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea rows={rows} className={cx(CONTROL, "leading-relaxed", invalid && "border-attn/55", className)} {...rest} />
  );
}

/**
 * The select keeps the browser's own arrow: a hand-drawn chevron has to move
 * with the open list, which costs a client component for something the browser
 * already does right. `bg-field` is what makes the closed state match the rest.
 */
export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx(CONTROL, "pr-3", className)} {...rest} />;
}

/**
 * A checkbox with the browser's own box, tinted through `accent-color`. That is
 * deliberately not a hand-drawn square: the real control already carries its
 * keyboard and screen-reader behaviour, which is worth more than a few pixels
 * of styling.
 */
export function Checkbox({ label, className, ...rest }:
  InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className={cx("inline-flex cursor-pointer items-center gap-[10px]", className)}>
      <input type="checkbox" className="size-[15px] accent-signal" {...rest} />
      <span className="text-[13.5px] font-light text-ink-soft">{label}</span>
    </label>
  );
}
