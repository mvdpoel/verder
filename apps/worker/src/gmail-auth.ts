import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { google, type Auth } from "googleapis";
import type { GmailMessage, GmailPort } from "./gmail";
import { isInlineBodyImage } from "./gmail-parts";

interface OAuthCreds {
  installed?: { client_id: string; client_secret: string };
  web?: { client_id: string; client_secret: string };
}

// Google retired the "oob" redirect; for a desktop-app credential the loopback
// address works: the browser redirects to a dead localhost URL and the user
// pastes the code (or the whole redirect URL) back into the terminal.
const REDIRECT_URI = "http://127.0.0.1";

export async function oauthClient(): Promise<Auth.OAuth2Client> {
  const creds = JSON.parse(
    await readFile(process.env.GMAIL_CREDENTIALS_PATH!, "utf8"),
  ) as OAuthCreds;
  const conf = creds.installed ?? creds.web;
  if (!conf) throw new Error("GMAIL_CREDENTIALS_PATH: expected an 'installed' or 'web' OAuth client");
  const client = new google.auth.OAuth2(conf.client_id, conf.client_secret, REDIRECT_URI);
  try {
    client.setCredentials(JSON.parse(await readFile(process.env.GMAIL_TOKEN_PATH!, "utf8")));
  } catch { /* not yet authorized */ }
  return client;
}

export type MessageListFn = (params: {
  userId: "me"; q: string; maxResults: number; pageToken?: string;
}) => Promise<{ data: {
  messages?: { id?: string | null }[] | null;
  nextPageToken?: string | null;
} }>;

// Gmail's messages.list is paged; a single page caps out well below what a
// live inbox can hold in 7 days, so follow nextPageToken until exhausted.
export async function listAllMessageIds(list: MessageListFn, query: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await list({ userId: "me", q: query, maxResults: 100, pageToken });
    ids.push(...(res.data.messages ?? []).map((m) => m.id!));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return ids;
}

export async function realGmailPort(): Promise<GmailPort> {
  const auth = await oauthClient();
  const gmail = google.gmail({ version: "v1", auth });
  return {
    listMessageIds: (query) =>
      listAllMessageIds((params) => gmail.users.messages.list(params), query),
    async getMessage(id): Promise<GmailMessage> {
      const raw = await gmail.users.messages.get({ userId: "me", id, format: "raw" });
      const full = await gmail.users.messages.get({ userId: "me", id, format: "full" });
      const headers = Object.fromEntries((full.data.payload?.headers ?? [])
        .map((h) => [h.name!.toLowerCase(), h.value ?? ""]));
      const attachments = full.data.payload
        ? await collectAttachments(full.data.payload, async (attachmentId) => {
            const att = await gmail.users.messages.attachments.get({
              userId: "me", messageId: id, id: attachmentId });
            return Buffer.from(att.data.data!, "base64url");
          })
        : [];
      const bodyPart = findTextPart(full.data.payload);
      return {
        id, threadId: full.data.threadId!, from: headers.from ?? "", to: headers.to ?? "",
        subject: headers.subject ?? "(no subject)",
        sentAt: new Date(Number(full.data.internalDate)),
        bodyText: bodyPart ? Buffer.from(bodyPart, "base64url").toString("utf8") : "",
        raw: Buffer.from(raw.data.raw!, "base64url"), attachments,
      };
    },
  };
}

// The Gmail payload tree, narrowed to what the walk actually reads. Declaring
// it structurally keeps this function testable without a googleapis client.
export interface MessagePart {
  filename?: string | null;
  mimeType?: string | null;
  body?: { attachmentId?: string | null } | null;
  headers?: { name?: string | null; value?: string | null }[] | null;
  parts?: MessagePart[] | null;
}

/**
 * Walk a message's part tree and promote the parts that are genuine
 * attachments to vault documents.
 *
 * A part earns a document only if it has a filename, has downloadable bytes,
 * and is NOT an image the HTML body embeds by `cid:` — see isInlineBodyImage.
 * The recursion runs regardless of the skip: a skipped part may still have
 * children worth keeping.
 */
export async function collectAttachments(
  payload: MessagePart,
  fetchBytes: (attachmentId: string) => Promise<Buffer>,
): Promise<GmailMessage["attachments"]> {
  const attachments: GmailMessage["attachments"] = [];
  const walk = async (part: MessagePart) => {
    for (const p of part.parts ?? []) {
      if (p.filename && p.body?.attachmentId && !isInlineBodyImage(p.headers)) {
        attachments.push({
          filename: p.filename, mime: p.mimeType ?? "application/octet-stream",
          data: await fetchBytes(p.body.attachmentId),
        });
      }
      if (p.parts) await walk(p);
    }
  };
  await walk(payload);
  return attachments;
}

function findTextPart(payload: unknown): string | null {
  const p = payload as { mimeType?: string; body?: { data?: string }; parts?: unknown[] } | undefined;
  if (!p) return null;
  if (p.mimeType === "text/plain" && p.body?.data) return p.body.data;
  for (const child of p.parts ?? []) { const r = findTextPart(child); if (r) return r; }
  return null;
}

// One-time interactive authorization when run directly: `pnpm --filter worker gmail:auth`
if (import.meta.url === `file://${process.argv[1]}`) {
  const client = await oauthClient();
  const url = client.generateAuthUrl({ access_type: "offline", prompt: "consent",
    scope: ["https://www.googleapis.com/auth/gmail.readonly"] });
  console.log("Open this URL, approve, then paste the code (or the full redirect URL):\n", url);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Code: ")).trim();
  // Accept either the bare code or the pasted http://127.0.0.1/?code=... URL.
  const code = answer.startsWith("http")
    ? new URL(answer).searchParams.get("code") ?? answer
    : answer;
  const { tokens } = await client.getToken(code);
  await writeFile(process.env.GMAIL_TOKEN_PATH!, JSON.stringify(tokens));
  console.log("Token saved. Gmail watching is ready to go.");
  process.exit(0);
}
