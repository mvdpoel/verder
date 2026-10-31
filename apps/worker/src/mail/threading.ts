import { normaliseMessageId } from "./message-id";

/**
 * THREADING HEADERS FOR A REPLY VERDER DRAFTS (plan 2, Task 12).
 *
 * A reply that lands outside the thread it answers is a reply the other side
 * reads without its context — and Gmail's own threading, which the 7-day clock
 * rides on (spec §12.10), groups by these headers as well. So the outbound
 * message carries `In-Reply-To` and `References` read from the ORIGINAL bytes
 * in the vault, which both ports store, rather than from a database column
 * only one of them fills.
 *
 * The header block is walked the way `extractMessageId` walks it, and for the
 * same reason: a forwarded body routinely quotes a header block, and a
 * `References:` line read out of a body would thread Martin's reply under a
 * stranger's conversation. So NOTHING is trusted until the RFC 5322 §2.1 empty
 * line has closed the block, a column-0 line that is not header-shaped ends the
 * walk, and the mbox `From ` envelope is exempt at index 0 only. The id itself
 * goes through `normaliseMessageId` so it is the same string the dedup stored.
 *
 * Pure, no I/O.
 */

/** Same bound, same reasoning as HEADER_SCAN_BYTES in message-id.ts. */
const HEADER_SCAN_BYTES = 1024 * 1024;

const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const isHeaderShaped = (line: string): boolean => /^[\x21-\x39\x3b-\x7e]+[ \t]*:/.test(line);

/**
 * Every header of a properly closed header block, unfolded, in order — or null
 * when the block never ended in an empty line (a fragment, a mangled export),
 * because a block that never closed cannot be told apart from a quoted one.
 */
export function headerFields(raw: Buffer): Array<{ name: string; value: string }> | null {
  const overflowed = raw.length > HEADER_SCAN_BYTES;
  const lines = raw.subarray(0, HEADER_SCAN_BYTES).toString("latin1").split(/\r?\n/);
  // A cut at a fixed offset manufactures a partial last line; see message-id.ts.
  if (overflowed) lines.pop();

  const fields: Array<{ name: string; value: string }> = [];
  let pending: string | null = null;
  const flush = () => {
    if (pending === null) return;
    const colon = pending.indexOf(":");
    fields.push({ name: asciiLower(pending.slice(0, colon).trim()), value: pending.slice(colon + 1).trim() });
  };
  for (const [index, line] of lines.entries()) {
    if (line === "") { flush(); return fields; }
    if (/^[ \t]/.test(line)) { if (pending !== null) pending += line; continue; }
    if (!isHeaderShaped(line)) {
      if (index === 0 && line.startsWith("From ")) continue;
      return null;
    }
    flush();
    pending = line;
  }
  return null;
}

/** A msg-id that is safe to write back into a header: printable ASCII, no
 *  whitespace, no angle bracket, with exactly one `@`. Anything else — a
 *  header-injection attempt, a broken client's junk — is dropped rather than
 *  echoed into mail Martin sends. */
const SAFE_ID_RE = /^[\x21-\x3b\x3d\x3f-\x7e]+@[\x21-\x3b\x3d\x3f-\x7e]+$/;
const isSafeId = (id: string): boolean => SAFE_ID_RE.test(id) && id.split("@").length === 2;

/** The bracketed ids in a header value, in order, without the brackets. */
function bracketedIds(value: string): string[] {
  return [...value.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]);
}

export function threadingHeaders(raw: Buffer): {
  messageId: string | null; inReplyTo: string | null; references: string[];
} {
  const fields = headerFields(raw);
  if (!fields) return { messageId: null, inReplyTo: null, references: [] };
  // First occurrence wins, as in extractMessageId: choosing between two
  // conflicting claims is not this module's call.
  const first = (name: string) => fields.find((f) => f.name === name)?.value ?? null;
  const mid = first("message-id");
  const irt = first("in-reply-to");
  const refs = first("references");
  return {
    messageId: mid === null ? null : normaliseMessageId(mid),
    inReplyTo: irt === null ? null : bracketedIds(irt)[0] ?? null,
    references: refs === null ? [] : bracketedIds(refs),
  };
}

/** How many ids `References` carries. The last ones, because they are the
 *  nearest ancestors and the ones threading actually needs. */
export const MAX_REFERENCES = 10;

/**
 * The headers for a reply to `parent`. `parent.references` should be the
 * parent's References, or — when it had none — its In-Reply-To (RFC 5322
 * §3.6.4); `threadAncestry` below does that.
 */
export function replyHeaders(parent: { messageId: string | null; references: string[] }): {
  inReplyTo?: string; references?: string;
} {
  const parentId = parent.messageId !== null && isSafeId(parent.messageId) ? parent.messageId : null;
  const chain = [...parent.references.filter(isSafeId), ...(parentId ? [parentId] : [])];
  const out: { inReplyTo?: string; references?: string } = {};
  if (parentId) out.inReplyTo = `<${parentId}>`;
  if (parentId && chain.length > 0) {
    out.references = chain.slice(-MAX_REFERENCES).map((id) => `<${id}>`).join(" ");
  }
  return out;
}

/** The parent's ancestry as RFC 5322 §3.6.4 builds a reply's References. */
export function threadAncestry(h: { inReplyTo: string | null; references: string[] }): string[] {
  if (h.references.length > 0) return h.references;
  return h.inReplyTo ? [h.inReplyTo] : [];
}

/** Adds "Re: " unless the subject already opens with re:/antw: (any case).
 *  Line breaks are collapsed: a subject is written into a header. */
export function replySubject(subject: string): string {
  const s = subject.replace(/[\r\n]+/g, " ").trim();
  return /^(re|antw)\s*:/i.test(s) ? s : `Re: ${s}`;
}

/**
 * The mailboxes of an address-list header (`To`, `Cc`), split at TOP-LEVEL
 * commas only — a comma inside a quoted display name (`"Willemse, Demi"`) or
 * inside angle brackets is not a separator. Each element is a candidate for
 * `senderAddress`, which refuses anything it cannot read unambiguously; this
 * function only splits and never decides what an address is.
 */
export function mailboxList(header: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  let angle = 0;
  for (let i = 0; i < header.length; i++) {
    const ch = header[i];
    if (inQuotes && ch === "\\" && i + 1 < header.length) { cur += ch + header[++i]; continue; }
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch === "<") angle++;
    else if (!inQuotes && ch === ">") angle = Math.max(0, angle - 1);
    if (ch === "," && !inQuotes && angle === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s !== "");
}
