"use client";

/**
 * The visible side of ⌘K. The palette itself listens on the window; this button
 * summons it with the same event, so no state has to be shared between the shell
 * and the palette for the sake of one button.
 */
export function PaletteTrigger() {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event("verder:palette"))}
      className="flex items-center gap-[9px] rounded-chip border border-edge px-3 py-1.5 font-mono text-[10.5px] tracking-[0.14em] uppercase text-ink-dim transition-colors hover:border-signal/50 hover:text-ink-soft"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="M15.5 15.5 L21 21" strokeLinecap="round" />
      </svg>
      Zoek in het dossier
      <span className="text-ink-faint">⌘K</span>
    </button>
  );
}
