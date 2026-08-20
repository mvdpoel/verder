import { eq } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { ingestDocument } from "@verder/api/src/routers/documents";
import { storeFile } from "@verder/api/src/storage";
import { recordRun } from "./heartbeat";

/** A message part the port refused to promote to a document — see
 *  isInlineBodyImage. Reported so a wrong skip is visible the same day rather
 *  than never: the part is gone from every surface and re-polling will not
 *  fetch it again. */
export interface SkippedPart {
  filename: string; mime: string; contentId: string | null;
}

export interface GmailMessage {
  id: string; threadId: string; from: string; to: string; subject: string;
  sentAt: Date; bodyText: string; raw: Buffer;
  attachments: { filename: string; mime: string; data: Buffer }[];
  skippedParts?: SkippedPart[];
}
export interface GmailPort {
  listMessageIds(query: string): Promise<string[]>;
  getMessage(id: string): Promise<GmailMessage>;
}

/**
 * Evidence-first ingest of one Gmail message: persist the canonical RFC822
 * original (full headers: Received, Message-ID, DKIM...) to the vault before
 * AI runs. A bare hash is only verifiable while Gmail retains the message; the
 * vault copy makes it independently verifiable forever. Attachments become
 * vault-backed documents in the same transaction.
 *
 * `skipSuggest` is for receipt lookups (registry aggregator resolution): those
 * emails are financial evidence, not correspondence, so no suggest.entry job
 * is ever owed — stamping the outbox marker at insert time keeps pollGmail's
 * outbox repair from enqueuing one later.
 */
export async function ingestRawEmail(
  deps: { db: Db; vaultDir: string },
  msg: GmailMessage,
  opts?: { skipSuggest?: boolean },
): Promise<string> {
  return deps.db.transaction(async (tx) => {
    const { sha256: rawSha256 } = await storeFile(deps.vaultDir, msg.raw);
    const [row] = await tx.insert(schema.rawEmails).values({
      gmailMessageId: msg.id, gmailThreadId: msg.threadId,
      fromAddr: msg.from, toAddr: msg.to, subject: msg.subject,
      sentAt: msg.sentAt, rawRfc822Sha256: rawSha256,
      bodyText: msg.bodyText,
      ...(opts?.skipSuggest ? { suggestQueuedAt: new Date() } : {}),
    }).returning();
    for (const att of msg.attachments) {
      const { sha256 } = await storeFile(deps.vaultDir, att.data);
      await ingestDocument(tx, { sha256, sizeBytes: att.data.length,
        mime: att.mime, title: att.filename, source: "email-attachment",
        sourceRef: msg.id, receivedAt: msg.sentAt });
    }
    return row.id;
  });
}

export async function pollGmail(deps: {
  db: Db; gmail: GmailPort; vaultDir: string;
  enqueueSuggest: (rawEmailId: string) => Promise<void>;
  query?: string;
}): Promise<{ ingested: number }> {
  const senders = (process.env.RELEVANT_SENDERS ?? "@verdergroep.nl").split(",");
  let ingested = 0;
  const failures: { id: string; message: string }[] = [];
  // Parts the port refused to promote. `scanned` counts messages, not parts, so
  // without this a heuristic that reads a sender's mailer wrongly would drop
  // documents with nothing anomalous anywhere to look at.
  const skippedParts: (SkippedPart & { messageId: string })[] = [];
  try {
    const partyEmails = (await deps.db.select().from(schema.parties))
      .map((p) => p.email).filter((e): e is string => !!e);
    const ids = await deps.gmail.listMessageIds(deps.query ?? "newer_than:7d");
    for (const id of ids) {
      // One bad message must not block the rest of the mailbox: isolate each
      // message so a persistent failure only surfaces in worker_runs while
      // every other message still ingests.
      try {
        const [seen] = await deps.db.select().from(schema.rawEmails)
          .where(eq(schema.rawEmails.gmailMessageId, id));
        if (seen) {
          // Outbox repair: the ingest committed but the suggest.entry enqueue
          // failed afterwards (send error or crash). Retry it now, otherwise
          // the email never reaches the review queue.
          if (!seen.suggestQueuedAt) await enqueueAndMark(deps, seen.id);
          continue;
        }
        const msg = await deps.gmail.getMessage(id);
        for (const p of msg.skippedParts ?? []) skippedParts.push({ ...p, messageId: id });
        const relevant = [...senders, ...partyEmails]
          .some((s) => msg.from.toLowerCase().includes(s.toLowerCase()));
        if (!relevant) continue;
        const rawEmailId = await ingestRawEmail(deps, msg);
        await enqueueAndMark(deps, rawEmailId);
        ingested++;
      } catch (err) {
        failures.push({ id, message: String(err) });
      }
    }
    await recordRun(deps.db, "gmail", failures.length ? "error" : "ok",
      { ingested, scanned: ids.length, failures, skippedParts });
  } catch (err) {
    await recordRun(deps.db, "gmail", "error", { message: String(err) });
    throw err;
  }
  return { ingested };
}

// Enqueue the suggest job, then mark the raw email as enqueued. If the mark
// itself fails the job is merely sent again next poll (at-least-once), which
// beats the alternative of an email that never reaches the review queue.
async function enqueueAndMark(
  deps: { db: Db; enqueueSuggest: (rawEmailId: string) => Promise<void> },
  rawEmailId: string,
): Promise<void> {
  await deps.enqueueSuggest(rawEmailId);
  await deps.db.update(schema.rawEmails).set({ suggestQueuedAt: new Date() })
    .where(eq(schema.rawEmails.id, rawEmailId));
}
