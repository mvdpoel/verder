"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
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
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
    <div className="fixed inset-0 z-50 bg-slate-900/30 p-4" onClick={() => setOpen(false)}>
      <div className="mx-auto max-w-xl rounded border bg-white shadow-lg"
        onClick={(e) => e.stopPropagation()}>
        <input ref={inputRef} value={q}
          placeholder="Search everything — ⇧Enter for all results"
          className="w-full border-b p-3 outline-none"
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
        <div className="max-h-96 overflow-y-auto p-2">
          {!searching && (
            <p className="px-2 py-1 text-xs text-slate-500">Recently updated</p>
          )}
          {groups.length === 0 && (
            <p className="px-2 py-3 text-sm text-slate-500">
              {results.isFetching || recent.isFetching
                ? "Searching…"
                : "Nothing found — try fewer words."}
            </p>
          )}
          {groups.map((g) => (
            <div key={g.entityType} className="py-1">
              <p className="px-2 text-xs font-medium text-slate-500">
                {ENTITY_LABEL[g.entityType as keyof typeof ENTITY_LABEL] ?? g.entityType}
              </p>
              <ul>
                {g.hits.map((h) => {
                  const i = flat.indexOf(h);
                  return (
                    <li key={`${h.entityType}:${h.entityId}`}>
                      <button
                        className={`w-full rounded px-2 py-1.5 text-left text-sm ${i === cursor ? "bg-slate-100" : ""}`}
                        onMouseEnter={() => setCursor(i)}
                        onClick={() => openHit(h)}>{h.title}</button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-slate-500">
          <span>↑↓ to move · Enter to open · ⇧Enter for all · Esc to close</span>
          <button className="hover:underline" onClick={seeAll}>see all results →</button>
        </div>
      </div>
    </div>
  );
}
