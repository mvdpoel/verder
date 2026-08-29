"use client";

import { useEffect, type ReactNode } from "react";
import { Label, Panel } from "./panel";

/**
 * The dialog: a scrim over the page, a panel above it.
 *
 * Escape closes, and so does the scrim — a confirmation you can only leave by
 * choosing is a trap, not a question. What it does NOT yet do is keep focus from
 * wandering into the page behind the scrim: that needs `inert` on the rest, and
 * a root this component does not own. Until then `role="dialog"` plus
 * `aria-modal` does the work for a screen reader.
 */
export function Dialog({
  open, onClose, kicker, title, children, footer,
}: {
  open: boolean;
  onClose: () => void;
  kicker?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // The page underneath must not scroll along while the dialog is open.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-6 pt-[12vh]">
      <div
        className="absolute inset-0 bg-scrim backdrop-blur-[3px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <Panel
        lit
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-lg shadow-[var(--shadow-lift)]"
      >
        <div className="flex flex-col gap-4 p-[26px]">
          {kicker ? <Label className="text-attn">{kicker}</Label> : null}
          <h2 className="text-xl font-light text-ink-bright">{title}</h2>
          {children ? (
            <div className="text-[13.5px] font-light leading-relaxed text-ink-mute">{children}</div>
          ) : null}
          {footer ? <div className="flex justify-end gap-[10px] pt-1">{footer}</div> : null}
        </div>
      </Panel>
    </div>
  );
}
