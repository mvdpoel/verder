import type { gmail_v1 } from "googleapis";
import { normaliseMessageId } from "../mail/message-id";

/**
 * LIVE GMAIL, READ ONLY (Vraag Grip spec, `gmail_search` / `gmail_read`).
 *
 * Two primitives over the worker's existing Gmail token, whose OAuth scope is
 * `gmail.readonly` (gmail-auth.ts) — so even a bug here cannot send, label or
 * delete. Attachment BYTES are never fetched: only their names, types and
 * sizes. Nothing read here is ingested into the vault.
 *
 * Bounded by grip-tools' per-request caps (10 searches, 20 reads), and a
 * search lists at most 20 messages with one metadata call each.
 */

export interface GmailHeaderView {
  gmailId: string; threadId: string; from: string; to: string; subject: string; date: string; snippet: string;
}
export interface GmailMessageView {
  gmailId: string; threadId: string; messageId: string | null; references: string[];
  from: string; to: string; cc: string; subject: string; date: string; body: string;
  attachments: { filename: string; mime: string; size: number }[];
}
export interface GmailReadPort {
  search(q: string, max: number): Promise<GmailHeaderView[]>;
  read(id: string): Promise<GmailMessageView>;
}

export const GMAIL_SEARCH_MAX = 20;

type Part = gmail_v1.Schema$MessagePart;
const header = (p: Part | undefined, name: string): string =>
  p?.headers?.find((h) => h.name?.toLowerCase() === name)?.value ?? "";

function decode(data: string | null | undefined): string {
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

/** The first text/plain part, else the first text/html part (stripped later). */
export function bodyOf(p: Part | undefined): string {
  const find = (part: Part | undefined, mime: string): string | null => {
    if (!part) return null;
    if (part.mimeType === mime && part.body?.data && !part.filename) return decode(part.body.data);
    for (const c of part.parts ?? []) { const r = find(c, mime); if (r !== null) return r; }
    return null;
  };
  return find(p, "text/plain") ?? find(p, "text/html") ?? "";
}

export function attachmentsOf(p: Part | undefined): GmailMessageView["attachments"] {
  const out: GmailMessageView["attachments"] = [];
  const walk = (part: Part | undefined) => {
    for (const c of part?.parts ?? []) {
      if (c.filename) out.push({ filename: c.filename, mime: c.mimeType ?? "application/octet-stream", size: c.body?.size ?? 0 });
      walk(c);
    }
  };
  walk(p);
  return out;
}

const dateOf = (internalDate: string | null | undefined, hdr: string): string => {
  const n = Number(internalDate);
  if (Number.isFinite(n) && n > 0) return new Date(n).toISOString();
  const d = new Date(hdr);
  return Number.isNaN(d.getTime()) ? hdr : d.toISOString();
};

export function gmailReadPortFor(gmail: gmail_v1.Gmail): GmailReadPort {
  return {
    async search(q, max) {
      const res = await gmail.users.messages.list({ userId: "me", q, maxResults: Math.min(max, GMAIL_SEARCH_MAX) });
      const out: GmailHeaderView[] = [];
      for (const m of res.data.messages ?? []) {
        if (!m.id) continue;
        const meta = await gmail.users.messages.get({ userId: "me", id: m.id, format: "metadata",
          metadataHeaders: ["From", "To", "Subject", "Date"] });
        const p = meta.data.payload ?? undefined;
        out.push({ gmailId: m.id, threadId: meta.data.threadId ?? m.threadId ?? "",
          from: header(p, "from"), to: header(p, "to"), subject: header(p, "subject"),
          date: dateOf(meta.data.internalDate, header(p, "date")), snippet: meta.data.snippet ?? "" });
      }
      return out;
    },
    async read(id) {
      const full = await gmail.users.messages.get({ userId: "me", id, format: "full" });
      const p = full.data.payload ?? undefined;
      // Bare ids (no angle brackets), as replyHeaders expects them.
      const refs = (header(p, "references").match(/<[^<>\s]+>/g) ?? [])
        .map(normaliseMessageId).filter((r): r is string => !!r);
      const mid = header(p, "message-id");
      return {
        gmailId: id, threadId: full.data.threadId ?? "",
        messageId: mid ? normaliseMessageId(mid) : null, references: refs,
        from: header(p, "from"), to: header(p, "to"), cc: header(p, "cc"),
        subject: header(p, "subject"), date: dateOf(full.data.internalDate, header(p, "date")),
        body: bodyOf(p), attachments: attachmentsOf(p),
      };
    },
  };
}

/** The real port, or null when the worker has no Gmail credentials configured. */
export async function realGmailReadPort(): Promise<GmailReadPort | null> {
  if (!process.env.GMAIL_CREDENTIALS_PATH || !process.env.GMAIL_TOKEN_PATH) return null;
  const [{ google }, { oauthClient }] = await Promise.all([import("googleapis"), import("../gmail-auth")]);
  const auth = await oauthClient();
  return gmailReadPortFor(google.gmail({ version: "v1", auth }));
}
