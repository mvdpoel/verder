import { z } from "zod";
import { mobilePost } from "@/lib/mobile-route";
import { fail } from "@/lib/mobile-json";
import { entryFromProposed } from "@grip/api/src/entry-from-proposed";
import { debtFields } from "@grip/api/src/routers/registry";
import { taskFields } from "@grip/api/src/routers/tasks";

/**
 * The phone never sends a whole procedure input, only the fields Martin
 * changed on the card. Anything else in the body (a `kind`, say) is ignored:
 * the procedure is chosen by the suggestion's STORED kind.
 */
const approveBody = z.object({ edits: z.record(z.unknown()).optional() });

/** Strict per kind: an unknown edit key is a 400, never silently dropped. */
const docMetaEdits = z.object({
  title: z.string().min(1), docType: z.string().nullable(),
}).partial().strict();
const debtEdits = debtFields.partial().strict();
const taskEdits = taskFields.partial().strict();

type Proposed = Record<string, unknown>;
const asObject = (v: unknown): Proposed =>
  (v !== null && typeof v === "object" && !Array.isArray(v) ? v : {}) as Proposed;
/** An emptied text box is "nothing", exactly as the web card sends it. */
const blankToUndefined = (v: unknown) => (v === "" || v === null ? undefined : v);

/**
 * Approves a suggestion as `{ ...proposed, ...edits }` through the SAME
 * procedure the web queue calls, so a phone verdict is recorded exactly as a
 * web one (verdict, edit diff, ledger event). A registry-item has no phone
 * form — its approve needs a category and evidence the card shows — so it is
 * 409 "open op de website".
 */
export const POST = mobilePost(async (caller, body, { id }) => {
  const edits = approveBody.parse(body).edits ?? {};
  const s = await caller.suggestions.get({ id });
  const p = asObject(s.proposed);
  switch (s.kind) {
    case "log-entry":
      return caller.suggestions.approveEntry({ id, entry: entryFromProposed(s, edits) });
    case "document-meta": {
      const e = docMetaEdits.parse(edits);
      const title = e.title ?? p.title ?? s.document?.effectiveTitle;
      const docType = "docType" in e ? e.docType : p.docType;
      await caller.suggestions.approveDocumentMeta({
        id, title: title as string, docType: blankToUndefined(docType) as string | undefined });
      return { ok: true };
    }
    case "debt": {
      const e = debtEdits.parse(edits);
      // The web card falls back to the counterparty when the miner named no
      // creditor; the phone approves the same debt.
      const debt = debtFields.parse({
        ...p, creditorName: p.creditorName ?? p.counterpartyName, ...e });
      return caller.suggestions.approveDebt({ id, debt });
    }
    case "task": {
      const e = taskEdits.parse(edits);
      const merged = { ...p, ...e };
      // The miner records `details: ""` when the model gives none, and the
      // card submits an empty box as absent; sending "" would record an
      // untouched task as "edited".
      const task = taskFields.parse({ ...merged, details: blankToUndefined(merged.details) });
      const created = await caller.suggestions.approveTask({ id, task });
      return { taskId: created.id };
    }
    case "registry-item":
      return fail("open op de website", 409);
    default:
      return fail(`unknown suggestion kind ${String(s.kind)}`, 400);
  }
});
