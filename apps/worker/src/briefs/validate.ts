import type { BriefContext } from "./context";

/**
 * NOTHING THE CONTEXT DID NOT OFFER IS EVER SHOWN (the proposals-store
 * discipline, applied to the one AI line on the call screen).
 *
 * The drafter read third-party mail, so its answer is untrusted twice over. It
 * must be exactly `{"summary": "<one Dutch sentence>", "sources": ["<id>", …]}`,
 * and EVERY cited id must be an item of the context the worker assembled. Any
 * failure refuses the WHOLE answer (the brief becomes `failed`, the raw output
 * is kept for the golden rule); a partly valid answer is never trimmed into a
 * valid one, because the part that failed is exactly the part an attacker
 * wrote. A summary that cites nothing is refused too: a line that cannot say
 * where it came from does not belong beside the dossier.
 *
 * Pure: no DB, no I/O.
 */

export const BRIEF_SUMMARY_MAX = 240;
export const BRIEF_SOURCES_MAX = 10;

export type BriefSourceRef = { type: "mail" | "task" | "debt"; id: string };
export type BriefVerdict =
  | { ok: true; summary: string; sourceRefs: BriefSourceRef[] }
  | { ok: false; reason: string };

/** Every id the context offered, with what it is. */
export function contextIds(ctx: BriefContext): Map<string, BriefSourceRef["type"]> {
  const ids = new Map<string, BriefSourceRef["type"]>();
  for (const m of ctx.mails) ids.set(m.id, "mail");
  for (const t of ctx.tasks) ids.set(t.id, "task");
  for (const d of ctx.debts) ids.set(d.id, "debt");
  return ids;
}

export function validateBrief(raw: string, ctx: BriefContext): BriefVerdict {
  let text = raw.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(text);
  if (fence) text = fence[1].trim();
  let v: unknown;
  try { v = JSON.parse(text); } catch { return { ok: false, reason: "the answer is not JSON" }; }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return { ok: false, reason: "the answer is not a JSON object" };
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== "summary" && k !== "sources");
  if (extra.length) return { ok: false, reason: `unknown key ${extra[0].slice(0, 40)}` };

  if (typeof o.summary !== "string") return { ok: false, reason: "summary is not a string" };
  const summary = o.summary.trim();
  if (summary === "") return { ok: false, reason: "summary is empty" };
  if (summary.length > BRIEF_SUMMARY_MAX) return { ok: false, reason: `summary is longer than ${BRIEF_SUMMARY_MAX} characters` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(summary)) return { ok: false, reason: "summary is more than one line" };

  if (!Array.isArray(o.sources)) return { ok: false, reason: "sources is not a list" };
  if (o.sources.length === 0) return { ok: false, reason: "sources is empty" };
  if (o.sources.length > BRIEF_SOURCES_MAX) return { ok: false, reason: `sources has more than ${BRIEF_SOURCES_MAX} entries` };
  const offered = contextIds(ctx);
  const sourceRefs: BriefSourceRef[] = [];
  for (const s of o.sources) {
    if (typeof s !== "string") return { ok: false, reason: "a source is not a string" };
    const type = offered.get(s);
    if (!type) return { ok: false, reason: `source ${s.slice(0, 80)} is not in the context` };
    if (!sourceRefs.some((r) => r.id === s)) sourceRefs.push({ type, id: s });
  }
  return { ok: true, summary, sourceRefs };
}
