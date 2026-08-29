import type { ReactNode } from "react";
import { cx } from "./cx";
import { Dot, type DotState } from "./row";

/**
 * A notice: one line, a dot carrying the tone, and at most one thing to do on
 * the right. `attn` is the only one with a coloured border, because it is the
 * only case where the notice itself is asking for attention.
 */
export function Notice({
  tone = "ok", action, className, children,
}: {
  tone?: "ok" | "attn" | "signal";
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cx(
        "panel flex items-center gap-[14px] px-[18px] py-[14px]",
        tone === "attn" && "border-attn/30",
        className,
      )}
    >
      <Dot state={tone === "attn" ? "you" : tone === "signal" ? "open" : "ok"} />
      <div className="grow text-[13.5px] font-light text-ink-soft">{children}</div>
      {action ? (
        <div
          className={cx(
            "shrink-0 font-mono text-[10px] tracking-[0.14em] uppercase",
            tone === "attn" ? "text-attn" : "text-signal",
          )}
        >
          {action}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The empty state. It says WHY nothing is there and what happens next — "no
 * results" leaves someone thinking something is broken, while an empty queue in
 * this dossier is usually good news.
 */
export function Empty({
  title, children, action,
}: {
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-panel border border-dashed border-edge-strong p-[30px]">
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" strokeWidth="1" strokeLinecap="round" aria-hidden="true" className="stroke-signal/45">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5M12 16.2v.1" />
      </svg>
      <div className="text-[15px] font-light text-ink-soft">{title}</div>
      {children ? (
        <p className="max-w-xs text-center text-[13px] font-light leading-relaxed text-ink-label">
          {children}
        </p>
      ) : null}
      {action}
    </div>
  );
}

/**
 * A verdict block: a bordered, faintly tinted box carrying a tone, sitting
 * INSIDE a panel.
 *
 * `Notice` is the near miss and is deliberately not this: it is one line with
 * one action, and it renders `.panel` itself — so used inside a card it stacks
 * glass on glass. This is flat, holds as many lines as the answer needs, and
 * was hand-rolled with the same three tone classes in `verify-panel.tsx` and
 * `index-health.tsx` before it lived here.
 *
 * The tone is a statement about WHO the result waits on, never a severity ramp.
 * `attn` is amber and therefore means the same thing it means everywhere else:
 * Martin is the only one who can move this on.
 */
const CALLOUT_TONE: Record<"ok" | "signal" | "attn", string> = {
  ok: "border-okay/25 bg-okay/5",
  signal: "border-signal/25 bg-signal/5",
  attn: "border-attn/35 bg-attn/5",
};

const CALLOUT_DOT: Record<"ok" | "signal" | "attn", DotState> = {
  ok: "ok", signal: "open", attn: "you",
};

export function Callout({
  tone = "signal", dot = false, className, children,
}: {
  tone?: "ok" | "signal" | "attn";
  /** A mark beside the text. Off by default: most callouts say it in words. */
  dot?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cx(
        "flex items-start gap-[12px] rounded-panel border px-[18px] py-[15px]",
        CALLOUT_TONE[tone],
        className,
      )}
    >
      {dot ? <Dot state={CALLOUT_DOT[tone]} className="mt-[5px]" /> : null}
      <div className="min-w-0 grow">{children}</div>
    </div>
  );
}

/**
 * A form-level error — the whole save was refused, not one field.
 *
 * The type is `Field`'s own error line, copied out of it so the two read the
 * same, and it is the documented exception to "amber means it is waiting on
 * you": a form that will not save is literally waiting on Martin to try again.
 * Six forms spelled this out by hand, and two of them had drifted to a
 * different size and weight entirely.
 */
export function FormError({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <p
      role="alert"
      className={cx("font-mono text-[10px] tracking-[0.12em] uppercase text-attn", className)}>
      {children}
    </p>
  );
}
