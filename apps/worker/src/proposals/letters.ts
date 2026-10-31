import { and, eq, inArray } from "drizzle-orm";
import { schema } from "@verder/db";
import { effectiveTitleSql, notDiscardedSql, notPurgedSql } from "@verder/api/src/effective-status";
import type { NotifyFn, NotifyInput } from "../notify/notify";
import { creditorParties, letterSender, prioritySets, type LetterSender } from "../mail/priority";
import { createProposal, type CreateDeps } from "./create";

/**
 * A SCANNED LETTER THAT LOOKS LIKE VERDER'S GETS THE VERDER TREATMENT
 * (spec §6.7, §12.5). Runs in the `suggest.docmeta` job, after the text has
 * been extracted and stored, with that same text.
 *
 *   - `verder`   → a time-sensitive push "Brief lijkt van Verder", then a
 *                  drafting proposal with `sender_guess {kind:'verder'}`;
 *   - `creditor` → the same at `active`, with the creditor as the guessed
 *                  party;
 *   - nothing recognisable → nothing.
 *
 * THE SENDER IS A GUESS. It came from OCR, so the push says "lijkt van", and
 * the guess is stored on the proposal, never on the document: the document's
 * party stays whatever Martin's filing makes it, and `proposals.get` derives
 * `senderUnconfirmed` from the two (Task 15). A false Verder guess costs one
 * time-sensitive push — the trade §12.5 accepts — and never a send, because
 * the draft can only address what `gatherContext` admitted and Martin approves
 * the final text.
 *
 * ONLY LETTERS. A mail attachment (`email-attachment`) already rode
 * `notifyForMail` and its mail's proposal; treating it again would push twice
 * for one message and draft a second answer beside the first. A loondossier
 * payslip is not correspondence. Discarded and purged documents are resolved
 * through the effective-status predicates every surface uses, because a discard
 * is never written back to `documents.status`.
 *
 * AT-LEAST-ONCE. `suggest.docmeta` may run twice for one document: the push is
 * deduplicated on `letter:<documentId>` and the proposal on the
 * `proposals_doc_trigger_uq` index, so a re-run is one push and one proposal.
 *
 * Nothing here is evidence: no ledger event.
 */

export const LETTER_SOURCES = ["nas-scan", "phone-scan", "phone-share", "upload"] as const;

export interface LetterDeps extends CreateDeps { notify: NotifyFn }

export interface LetterResult {
  sender: LetterSender | null;
  created: boolean;
  proposalId?: string;
}

export async function proposalForLetter(
  deps: LetterDeps, documentId: string, text: string,
): Promise<LetterResult> {
  const { db } = deps;
  const [doc] = await db.select({ id: schema.documents.id, title: effectiveTitleSql })
    .from(schema.documents)
    .where(and(eq(schema.documents.id, documentId),
      inArray(schema.documents.source, [...LETTER_SOURCES]),
      notDiscardedSql, notPurgedSql));
  if (!doc) return { sender: null, created: false };

  const creditors = await creditorParties(db);
  const sender = letterSender(await prioritySets(db), text, creditors);
  if (!sender) return { sender: null, created: false };

  const key = `letter:${documentId}`;
  const push: Pick<NotifyInput, "kind" | "level" | "title"> = sender.kind === "verder"
    ? { kind: "verder-mail", level: "time-sensitive", title: "Brief lijkt van Verder" }
    : {
      kind: "creditor-mail", level: "active",
      title: `Brief lijkt van ${creditors.find((c) => c.partyId === sender.partyId)?.name ?? "een schuldeiser"}`,
    };
  // Before the proposal exists, so it links to the Voor jou tab; the
  // "Voorstel" push for this letter reuses the collapse id and replaces it.
  await deps.notify({
    ...push, body: doc.title, link: "verder://inbox", dedupKey: key, threadId: key, collapseId: key,
  });

  const { id, created } = await createProposal(
    deps, { documentId, senderGuess: sender }, sender.kind === "verder" ? "verder" : "creditor",
  );
  return { sender, created, proposalId: id };
}
