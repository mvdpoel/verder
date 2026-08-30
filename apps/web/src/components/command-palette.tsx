"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { cx, Empty, Label, Micro, Panel } from "@/components/ui";
import { ENTITY_LABEL } from "@/components/search-kinds";
import { flatOrder, groupHits, nextIndex, type PaletteHit } from "@/lib/palette";

// The fast path into the dossier: ⌘K / Ctrl+K anywhere in the app. Everything
// it can reach, /search can reach too — the palette is never the only way in,
// and it never mutates anything.

const MIN_QUERY = 2;
const HITS = 8;
const DEBOUNCE_MS = 150;

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Global shortcut, registered once. The handler only calls setState, so it
  // never needs re-binding as the query changes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((was) => !was);
      }
      if (e.key === "Escape") setOpen(false);
    };
    // The search button in the top bar fires this event. The shortcut stays the
    // way in and the button is its visible side, so the palette never has to
    // hand state out to the shell around it.
    const onSummon = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("verder:palette", onSummon);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("verder:palette", onSummon);
    };
  }, []);

  // 150 ms debounce: one request per pause in typing, not one per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => { setCursor(0); }, [debounced]);

  const searching = debounced.length >= MIN_QUERY;
  const results = trpc.search.query.useQuery(
    { q: debounced, limit: HITS, mode: "fast" as const },
    { enabled: open && searching },
  );
  const recent = trpc.search.recent.useQuery(
    { limit: HITS },
    { enabled: open && !searching },
  );

  const hits: PaletteHit[] = useMemo(() => {
    const source = searching
      ? results.data?.hits ?? []
      : recent.data ?? [];
    return source.map((h) => ({
      entityType: h.entityType, entityId: h.entityId, title: h.title, href: h.href,
    }));
  }, [searching, results.data, recent.data]);

  const groups = groupHits(hits);
  const flat = flatOrder(groups);

  function openHit(hit: PaletteHit | undefined) {
    if (!hit) return;
    setOpen(false);
    router.push(hit.href);
  }
  function seeAll() {
    setOpen(false);
    router.push(`/search?q=${encodeURIComponent(q.trim())}`);
  }

  if (!open) return null;
  return (
    // Same scrim-and-panel as `Dialog`: the palette floats over the whole app,
    // and the blur is what stops the page behind it competing with the list.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-6 pt-[12vh]"
      onClick={() => setOpen(false)}
    >
      <div className="absolute inset-0 bg-scrim backdrop-blur-[3px]" aria-hidden="true" />
      <Panel
        lit
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-xl shadow-[var(--shadow-lift)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/*
          The focus ring lives on this row rather than on the input: the panel
          clips its own overflow, so an outline drawn around a full-width input
          would be cut off on three sides. A cyan underline says the same thing
          and survives.
        */}
        <div className="flex items-center gap-[12px] border-b border-hairline px-[18px] transition-colors focus-within:border-signal/60">
          <svg
            width="15" height="15" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"
            className="shrink-0 text-ink-dim" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M16.5 16.5 L21 21" />
          </svg>
          <input ref={inputRef} value={q}
            placeholder="Zoek in alles — ⇧Enter voor alle resultaten"
            className="w-full bg-transparent py-[15px] font-display text-[15px] font-light text-ink outline-none placeholder:text-ink-dim"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => nextIndex(flat.length, c, e.key as "ArrowDown" | "ArrowUp"));
              } else if (e.key === "Enter" && e.shiftKey) {
                e.preventDefault();
                seeAll();
              } else if (e.key === "Enter") {
                e.preventDefault();
                openHit(flat[cursor]);
              }
            }} />
        </div>
        <div className="max-h-96 overflow-y-auto p-[10px]">
          {!searching && (
            // An untyped palette is not an empty result: it is the shelf of what
            // moved last, and it says so before the first group.
            <Micro className="px-[10px] pb-[8px]">Laatst gewijzigd</Micro>
          )}
          {groups.length === 0 && (
            results.isFetching || recent.isFetching ? (
              <Micro className="px-[10px] py-[16px]">Bezig met zoeken…</Micro>
            ) : (
              <div className="px-[6px] py-[8px]">
                <Empty title="Niets gevonden — probeer minder woorden." />
              </div>
            )
          )}
          {groups.map((g) => (
            <div key={g.entityType} className="pb-[10px]">
              <Label className="px-[10px] pb-[6px]">
                {ENTITY_LABEL[g.entityType as keyof typeof ENTITY_LABEL] ?? g.entityType}
              </Label>
              <ul>
                {g.hits.map((h) => {
                  const i = flat.indexOf(h);
                  return (
                    <li key={`${h.entityType}:${h.entityId}`}>
                      <button
                        className={cx(
                          "w-full rounded-chip px-[10px] py-[9px] text-left text-[13.5px] font-light transition-colors",
                          i === cursor
                            ? "bg-signal/10 text-ink-bright"
                            : "text-ink-soft hover:text-ink-bright",
                        )}
                        onMouseEnter={() => setCursor(i)}
                        onClick={() => openHit(h)}>{h.title}</button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between gap-4 border-t border-hairline px-[18px] py-[12px]">
          <span className="font-mono text-[10px] tracking-[0.12em] text-ink-dim">
            ↑↓ bewegen · Enter openen · ⇧Enter alles · Esc sluiten
          </span>
          <button
            className="shrink-0 font-mono text-[10px] tracking-[0.16em] uppercase text-signal transition-colors hover:text-signal-link"
            onClick={seeAll}>alle resultaten →</button>
        </div>
      </Panel>
    </div>
  );
}
