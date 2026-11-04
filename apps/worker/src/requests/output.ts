import { createHash } from "node:crypto";
import type { schema } from "@grip/db";
import { senderAddress } from "../gmail";
import { mailboxList } from "../mail/threading";

type RequestToolRef = schema.RequestToolRef;

/**
 * How a tool result is shaped for the model, and how its ids are read back.
 *
 * ONE CONVENTION MAKES CITATIONS CHECKABLE: every entity a tool shows is an
 * object carrying `type` and `id`, and every address it shows sits in an
 * `addresses` array (parsed strictly, never a display name). `refsOf` walks the
 * FINAL result — after `fitResult` has trimmed it — so the tool log records
 * exactly what the model saw and not what the query returned. `requests-store`
 * then refuses any source, attachment, recipient or reply target that is not
 * among those refs.
 */

/** The spec's bound on one tool result. */
export const RESULT_MAX_CHARS = 8000;
/** A long text (a document, a mail body) is shown this much at a time. */
export const TEXT_PAGE_CHARS = 5000;

export const REF_TYPES = new Set([
  "document", "mail", "gmail", "transaction", "party", "debt", "stop", "task", "entry", "track",
]);

const FENCE_OPEN = "<<<DATA";
const FENCE_CLOSE = "DATA>>>";

/** Third-party text, fenced, with any fence marker inside it neutralised so a
 *  mail that writes `DATA>>>` cannot close its own fence. */
export function fenced(text: string): string {
  return `${FENCE_OPEN}\n${text.replace(/<<</g, "‹‹‹").replace(/>>>/g, "›››")}\n${FENCE_CLOSE}`;
}

/** One page of a long text, fenced, with where the next page starts. */
export function page(text: string, offset: number): { text: string; offset: number; nextOffset: number | null; totalChars: number } {
  const start = Math.max(0, Math.min(offset, text.length));
  const end = Math.min(text.length, start + TEXT_PAGE_CHARS);
  return { text: fenced(text.slice(start, end)), offset: start, nextOffset: end < text.length ? end : null, totalChars: text.length };
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", euro: "€", eacute: "é", euml: "ë",
};

/** A mail body as text: HTML (JMAP stores the text/html part when there is no
 *  text/plain one) is stripped to its words. Plain text passes through. */
export function plainBody(body: string): string {
  if (!/<(html|body|div|p|br|table|span)\b/i.test(body)) return body;
  return body
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
}

/** Every address of one or more headers, strictly parsed (`senderAddress`):
 *  `"demi@verdergroep.nl" <attacker@evil.tld>` contributes nothing. */
export function addressesOf(...headers: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const h of headers) {
    if (!h) continue;
    for (const m of mailboxList(h)) {
      const a = senderAddress(m);
      if (a && !out.includes(a)) out.push(a);
    }
  }
  return out;
}

export const clip = (s: string | null | undefined, n: number): string | null =>
  s == null ? null : s.length > n ? `${s.slice(0, n - 1)}…` : s;

export const euro = (cents: number | null | undefined): string =>
  cents == null ? "onbekend"
    : `${cents < 0 ? "-" : ""}€ ${(Math.abs(cents) / 100).toFixed(2).replace(".", ",")}`;

export const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : new Date(d).toISOString();

type Json = Record<string, unknown>;

/**
 * The result, trimmed until its JSON is at most `max` characters: first the
 * longest list loses items from its end (and the result says so), then the
 * longest string is halved. Never more than that: a result is never padded or
 * reordered.
 */
export function fitResult(data: Json, max = RESULT_MAX_CHARS): Json {
  const out = structuredClone(data) as Json;
  let dropped = 0;
  for (let guard = 0; guard < 2000 && JSON.stringify(out).length > max; guard++) {
    const lists: unknown[][] = [];
    const strings: { owner: Json | unknown[]; key: string | number; len: number }[] = [];
    const walk = (v: unknown, owner: Json | unknown[] | null, key: string | number | null) => {
      if (Array.isArray(v)) {
        if (v.length > 1) lists.push(v);
        v.forEach((x, i) => walk(x, v, i));
      } else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v as Json)) walk(x, v as Json, k);
      } else if (typeof v === "string" && owner && key !== null && v.length > 200) {
        strings.push({ owner, key, len: v.length });
      }
    };
    walk(out, null, null);
    const longest = lists.sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
    if (longest) {
      longest.pop();
      dropped++;
      // Said INSIDE the loop, so the note itself counts against the limit.
      out.truncated = true;
      out.note = `${dropped} resultaten weggelaten om binnen de limiet te blijven: verfijn de vraag of gebruik offset.`;
      continue;
    }
    const s = strings.sort((a, b) => b.len - a.len)[0];
    if (!s) break;
    const cur = (s.owner as Record<string | number, string>)[s.key];
    (s.owner as Record<string | number, string>)[s.key] = `${cur.slice(0, Math.floor(cur.length / 2))}…`;
  }
  return out;
}

const LABEL_KEYS = ["title", "name", "subject", "summary", "label"];

/** The ids (and strictly parsed addresses) a result showed, deduplicated. */
export function refsOf(data: unknown): RequestToolRef[] {
  const out: RequestToolRef[] = [];
  const seen = new Set<string>();
  const add = (r: RequestToolRef) => {
    const k = `${r.type}:${r.id}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(r);
  };
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== "object") return;
    const o = v as Json;
    if (typeof o.type === "string" && typeof o.id === "string" && REF_TYPES.has(o.type)) {
      const label = LABEL_KEYS.map((k) => o[k]).find((x): x is string => typeof x === "string");
      add({ type: o.type as RequestToolRef["type"], id: o.id, ...(label ? { label: clip(label, 120)! } : {}) });
    }
    if (Array.isArray(o.addresses)) {
      for (const a of o.addresses) if (typeof a === "string") add({ type: "address", id: a.toLowerCase() });
    }
    for (const x of Object.values(o)) walk(x);
  };
  walk(data);
  return out;
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
