import type { ReactNode } from "react";
import { cx } from "./cx";
import { Dot } from "./row";

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
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#63d3ea73" strokeWidth="1" strokeLinecap="round" aria-hidden="true">
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
