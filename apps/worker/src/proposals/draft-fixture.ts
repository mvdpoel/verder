// A hand-built ProposalContext for the pure drafter tests (prompt, validation).
// No database: every id is a fresh UUID, so nothing here can collide with a row.
import type { ProposalContext } from "./context";

export function fixtureContext(): ProposalContext & { ids: Record<string, string> } {
  const id = () => crypto.randomUUID();
  const ids = {
    trigger: id(), older: id(), attachment: id(), discarded: id(), party: id(), parent: id(),
    entry: id(), debt: id(), task: id(), waitingTask: id(), stop: id(),
    kbDoc: id(), sentDoc: id(), debtDoc: id(),
  };
  const attachment = { type: "document" as const, id: ids.attachment, label: "Loonstrook september.pdf" };
  const discarded = { type: "document" as const, id: ids.discarded, label: "image.png" };
  const trigger = {
    type: "email" as const, id: ids.trigger,
    label: "2026-10-30 · Team Opstart <opstart@verdergroep.nl> — Informatie over uw dossier",
    text: "Beste Martin,\n\nWilt u uw loonstrook van oktober aanleveren?\n\nMet vriendelijke groet,\nTeam Opstart",
    attachments: [attachment, discarded],
  };
  const older = {
    type: "email" as const, id: ids.older,
    label: "2026-10-20 · Martin <martin@vanderpoel.pro> — Informatie over uw dossier",
    text: "Hierbij de loonstrook van september.", attachments: [],
  };
  return {
    ids,
    trigger,
    thread: [older, trigger],
    party: { type: "party", id: ids.party, label: "Team Opstart (Verder)", text: "opstart@verdergroep.nl" },
    parentParty: { type: "party", id: ids.parent, label: "Verder" },
    entries: [{ type: "entry", id: ids.entry, label: "2026-10-20 · outbound email: loonstrook september gestuurd" }],
    debts: [{ type: "debt", id: ids.debt, label: "PLM Investments (incasso) — € 123,45" }],
    tasks: [
      { type: "task", id: ids.task, status: "open", label: "Loonstrook oktober aanleveren [open]" },
      { type: "task", id: ids.waitingTask, status: "waiting", label: "Reactie Verder afwachten [waiting]" },
    ],
    stops: [{ type: "stop", id: ids.stop, label: "Stukken aanleveren (open)" }],
    kb: [
      { type: "kb", id: ids.kbDoc, label: "document: Beschikking", text: "zaak NLTZ2612548IVB" },
      // A kb hit for an entry already listed above: one id, rendered once.
      { type: "kb", id: ids.entry, label: "entry: loonstrook september gestuurd" },
    ],
    sentDocuments: [{ type: "document", id: ids.sentDoc, label: "Loonstrook september.pdf" }],
    attachable: [
      attachment,
      { type: "document", id: ids.sentDoc, label: "Loonstrook september.pdf" },
      { type: "document", id: ids.debtDoc, label: "Sommatie PLM.pdf" },
      { type: "document", id: ids.kbDoc, label: "Beschikking.pdf" },
    ],
    addresses: ["opstart@verdergroep.nl", "demi@verdergroep.nl"],
    threadKey: "gmail:thread-1",
    gmailThreadId: "thread-1",
    reply: { inReplyTo: "<abc@verdergroep.nl>", references: "<abc@verdergroep.nl>", subject: "Re: Informatie over uw dossier" },
  };
}
