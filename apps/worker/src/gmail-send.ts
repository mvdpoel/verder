import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { Readable } from "node:stream";
import { google, type gmail_v1 } from "googleapis";
import { oauthClient } from "./gmail-auth";
import {
  findSentWith, NotSentError, type GmailSearch, type SendPort, type SentMatch,
} from "./proposals/send";

/**
 * THE REAL SEND PORT (Plan 2 Task 16). TWO tokens, never mixed:
 *
 *   - `send` uses the `gmail.send`-scope token at GMAIL_SEND_TOKEN_PATH,
 *     mounted READ-ONLY (Task 21), paired with the existing verder-worker OAuth
 *     client at GMAIL_CREDENTIALS_PATH — the client that minted it (Task 1
 *     Step 3, read from gsend-auth.mts, never from the token). It makes exactly
 *     one `users.messages.send` per call.
 *   - `findSent` uses the READ-ONLY ingest client (`oauthClient`), because the
 *     send scope cannot search. It never sends.
 *
 * Nothing is built at module scope and nothing is read until a call needs it,
 * so a worker without the send token boots and every other job runs; `ready`
 * reports the gap and the send job then claims nothing. The token's contents
 * are never logged: an error names the variable, never the value.
 */
export async function realSendPort(): Promise<SendPort> {
  let sender: gmail_v1.Gmail | null = null;
  let reader: gmail_v1.Gmail | null = null;

  const sendClient = async (): Promise<gmail_v1.Gmail> => {
    if (sender) return sender;
    const path = process.env.GMAIL_SEND_TOKEN_PATH;
    if (!path) throw new NotSentError("GMAIL_SEND_TOKEN_PATH is not set");
    let token: unknown;
    try { token = JSON.parse(await readFile(path, "utf8")); }
    catch { throw new NotSentError("the send token at GMAIL_SEND_TOKEN_PATH could not be read"); }
    // oauthClient builds the verder-worker client and loads the READ-ONLY
    // token; the send token then REPLACES those credentials on this instance,
    // which is its own object and never shared with the reader below.
    const client = await oauthClient();
    client.setCredentials(token as Parameters<typeof client.setCredentials>[0]);
    sender = google.gmail({ version: "v1", auth: client });
    return sender;
  };
  const readClient = async (): Promise<gmail_v1.Gmail> => {
    if (!reader) reader = google.gmail({ version: "v1", auth: await oauthClient() });
    return reader;
  };

  const search: GmailSearch = {
    async list(q) {
      const g = await readClient();
      const res = await g.users.messages.list({ userId: "me", q, maxResults: 50 });
      return (res.data.messages ?? [])
        .filter((m) => m.id)
        .map((m): SentMatch => ({ id: m.id!, threadId: m.threadId ?? "" }));
    },
    async meta(id) {
      const g = await readClient();
      const res = await g.users.messages.get({ userId: "me", id, format: "metadata",
        metadataHeaders: ["Subject"] });
      const subject = (res.data.payload?.headers ?? [])
        .find((h) => h.name?.toLowerCase() === "subject")?.value ?? "";
      return { subject, internalDate: new Date(Number(res.data.internalDate ?? 0)) };
    },
  };

  return {
    async ready() {
      const path = process.env.GMAIL_SEND_TOKEN_PATH;
      if (!path) return "GMAIL_SEND_TOKEN_PATH is not set";
      try { await access(path, constants.R_OK); }
      catch { return "the send token at GMAIL_SEND_TOKEN_PATH is not readable"; }
      if (!process.env.GMAIL_CREDENTIALS_PATH) return "GMAIL_CREDENTIALS_PATH is not set";
      return null;
    },
    async send(raw, threadId) {
      const g = await sendClient();
      const res = await g.users.messages.send({
        userId: "me",
        requestBody: threadId ? { threadId } : {},
        media: { mimeType: "message/rfc822", body: Readable.from(raw) },
      });
      // A 2xx without an id is an answer we cannot read — NOT proof of
      // non-delivery, so it is a plain error and the row waits for recovery.
      if (!res.data.id) throw new Error("Gmail accepted the send but returned no message id");
      return { id: res.data.id, threadId: res.data.threadId ?? threadId ?? "" };
    },
    findSent: (q) => findSentWith(search, q),
  };
}
