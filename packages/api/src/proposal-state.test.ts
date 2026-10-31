import { describe, expect, it } from "vitest";
import {
  PROPOSAL_STATUSES, PROPOSAL_TRANSITIONS, canTransition, proposalDiff, verdictFor,
  type ReplyPayload,
} from "./proposal-state";

const base: ReplyPayload = {
  to: ["opstart@verdergroep.nl"], cc: [], subject: "Re: Informatie over uw dossier",
  body: "Beste mevrouw,\n\nIn de bijlage vindt u mijn loonstrook.\n\nMet vriendelijke groet,\nMartin van der Poel",
  attachmentDocumentIds: ["doc-a", "doc-b"], entrySummary: "Loonstrook oktober gestuurd",
};

describe("state machine", () => {
  it("sent is terminal", () => {
    for (const to of PROPOSAL_STATUSES) {
      expect(canTransition("sent", to, "reply")).toBe(false);
      expect(canTransition("sent", to, "question")).toBe(false);
    }
    expect(PROPOSAL_TRANSITIONS.sent).toEqual([]);
  });

  it("sending cannot go back to approved", () => {
    expect(canTransition("sending", "approved", "reply")).toBe(false);
    expect(canTransition("sending", "pending", "reply")).toBe(false);
    expect(canTransition("sending", "sent", "reply")).toBe(true);
    expect(canTransition("sending", "failed", "reply")).toBe(true);
  });

  it("draft-failed may be retried", () => {
    expect(canTransition("draft-failed", "drafting", "reply")).toBe(true);
    expect(canTransition("draft-failed", "pending", "reply")).toBe(false);
  });

  it("question answer path is a legal transition", () => {
    expect(canTransition("pending", "sent", "question")).toBe(true);
  });

  it("a reply cannot go pending → sent", () => {
    expect(canTransition("pending", "sent", "reply")).toBe(false);
    expect(canTransition("pending", "sent", "follow-up")).toBe(false);
  });

  it("failed, rejected and superseded are final: a new attempt is a new proposal", () => {
    for (const from of ["failed", "rejected", "superseded"] as const) {
      for (const to of PROPOSAL_STATUSES) expect(canTransition(from, to, "reply")).toBe(false);
    }
  });

  it("a status never transitions to itself", () => {
    for (const s of PROPOSAL_STATUSES) expect(canTransition(s, s, "question")).toBe(false);
  });
});

describe("verdict and diff", () => {
  it("identical payload is approved", () => {
    expect(verdictFor(base, structuredClone(base))).toBe("approved");
    expect(proposalDiff(base, structuredClone(base))).toEqual({ fields: [], body: null });
  });

  it("whitespace-only body change is edited", () => {
    const final = { ...base, body: base.body.replace("Beste mevrouw,", "Beste mevrouw, ") };
    expect(verdictFor(base, final)).toBe("edited");
    const d = proposalDiff(base, final);
    expect(d.fields).toEqual(["body"]);
    expect(d.body).toContain("-Beste mevrouw,\n");
    expect(d.body).toContain("+Beste mevrouw, \n");
  });

  it("removed attachment is edited and listed in fields", () => {
    const final = { ...base, attachmentDocumentIds: ["doc-a"] };
    expect(verdictFor(base, final)).toBe("edited");
    expect(proposalDiff(base, final)).toEqual({ fields: ["attachmentDocumentIds"], body: null });
  });

  it("reordering the same recipients or attachments is not an edit", () => {
    const model = { ...base, to: ["a@verdergroep.nl", "b@verdergroep.nl"] };
    const final = { ...model, to: ["b@verdergroep.nl", "a@verdergroep.nl"],
      attachmentDocumentIds: ["doc-b", "doc-a"] };
    expect(verdictFor(model, final)).toBe("approved");
  });

  it("a changed subject, cc and summary are each listed", () => {
    const final = { ...base, subject: "Loonstrook", cc: ["demi@verdergroep.nl"], entrySummary: "Anders" };
    expect(proposalDiff(base, final).fields).toEqual(["cc", "subject", "entrySummary"]);
  });

  it("the body diff is line-based and keeps context", () => {
    const model = { ...base, body: "a\nb\nc" };
    const final = { ...base, body: "a\nB\nc\nd" };
    expect(proposalDiff(model, final).body).toBe(
      "--- model\n+++ final\n@@ -1,3 +1,4 @@\n a\n-b\n+B\n c\n+d\n",
    );
  });
});
