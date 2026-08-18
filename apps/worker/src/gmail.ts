import { eq } from "drizzle-orm";
import { sha256Hex } from "@verder/core";
import { schema, type Db } from "@verder/db";
import { ingestDocument } from "@verder/api/src/routers/documents";
import { storeFile } from "@verder/api/src/storage";
import { recordRun } from "./heartbeat";

export interface GmailMessage {
  id: string; threadId: string; from: string; to: string; subject: string;
  sentAt: Date; bodyText: string; raw: Buffer;
  attachments: { filename: string; mime: string; data: Buffer }[];
}
export interface GmailPort {
  listMessageIds(query: string): Promise<string[]>;
  getMessage(id: string): Promise<GmailMessage>;
}

export async function pollGmail(deps: {
  db: Db; gmail: GmailPort; vaultDir: string;
  enqueueSuggest: (rawEmailId: string) => Promise<void>;
}): Promise<{ ingested: number }> {
  const senders = (process.env.RELEVANT_SENDERS ?? "@verdergroep.nl").split(",");
  const partyEmails = (await deps.db.select().from(schema.parties))
    .map((p) => p.email).filter((e): e is string => !!e);
  const ids = await deps.gmail.listMessageIds("newer_than:7d");
  let ingested = 0;
  try {
    for (const id of ids) {
      const [seen] = await deps.db.select().from(schema.rawEmails)
        .where(eq(schema.rawEmails.gmailMessageId, id));
      if (seen) continue;
      const msg = await deps.gmail.getMessage(id);
      const relevant = [...senders, ...partyEmails]
        .some((s) => msg.from.toLowerCase().includes(s.toLowerCase()));
      if (!relevant) continue;
      const rawEmailId = await deps.db.transaction(async (tx) => {
        const [row] = await tx.insert(schema.rawEmails).values({
          gmailMessageId: msg.id, gmailThreadId: msg.threadId,
          fromAddr: msg.from, toAddr: msg.to, subject: msg.subject,
          sentAt: msg.sentAt, rawRfc822Sha256: sha256Hex(msg.raw),
          bodyText: msg.bodyText,
        }).returning();
        for (const att of msg.attachments) {
          const { sha256 } = await storeFile(deps.vaultDir, att.data);
          await ingestDocument(tx, { sha256, sizeBytes: att.data.length,
            mime: att.mime, title: att.filename, source: "email-attachment",
            sourceRef: msg.id, receivedAt: msg.sentAt });
        }
        return row.id;
      });
      await deps.enqueueSuggest(rawEmailId);
      ingested++;
    }
    await recordRun(deps.db, "gmail", "ok", { ingested, scanned: ids.length });
  } catch (err) {
    await recordRun(deps.db, "gmail", "error", { message: String(err) });
    throw err;
  }
  return { ingested };
}
