import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { entryForApproval, entryFromProposed, entrySource } from "./entry-from-proposed";

const DOC_A = "5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const DOC_B = "0b6f1c7e-3c1a-4d7e-9f3a-2a1b3c4d5e6f";
const PARTY = "7a2e4c1d-9b3f-4e8a-a1c2-3d4e5f6a7b8c";

const proposed = {
  occurredAt: "2026-10-29T13:00:00.000Z", channel: "email", direction: "inbound",
  summary: "Verder vraagt loonstroken", details: "Juni en juli.",
  participantNames: ["Team Opstart"],
  actionItems: [{ description: "Loonstroken sturen", clarity: "clear" }],
  attachmentDocumentIds: [DOC_A],
};
const mailSuggestion = { rawEmailId: "r-1", promptVersion: "entry-v1", proposed };

/**
 * What `SuggestionCard`'s EntryCard sent to approveEntry before the mapping
 * was extracted, copied verbatim from suggestion-card.tsx at 0d7e3e2. The
 * server parsed it with entryForApproval, so the parsed value is the fact.
 */
function cardBeforeExtraction(p: typeof proposed, summary: string, details: string, pickedDocIds: string[]) {
  return {
    occurredAt: new Date(p.occurredAt), channel: p.channel as "email", direction: p.direction,
    summary, details: details || undefined, source: "gmail-watch",
    participantPartyIds: [],
    documentIds: [...new Set([...p.attachmentDocumentIds, ...pickedDocIds])],
    actionItems: p.actionItems };
}

describe("entryFromProposed", () => {
  it("entryFromProposed matches what SuggestionCard sent before the extraction", () => {
    for (const [summary, details, picked] of [
      [proposed.summary, proposed.details, []],
      ["Verder vraagt loonstroken juni+juli", "", [DOC_B, DOC_A]],
    ] as const) {
      const before = entryForApproval.parse(cardBeforeExtraction(proposed, summary, details, [...picked]));
      const after = entryFromProposed(mailSuggestion, {
        summary, details,
        attachmentDocumentIds: [...new Set([...proposed.attachmentDocumentIds, ...picked])] });
      expect(after).toEqual(before);
    }
  });

  it("builds the entry from proposed alone when nothing was edited", () => {
    expect(entryFromProposed(mailSuggestion)).toEqual({
      occurredAt: new Date("2026-10-29T13:00:00.000Z"), channel: "email", direction: "inbound",
      summary: "Verder vraagt loonstroken", details: "Juni en juli.", source: "gmail-watch",
      participantPartyIds: [], documentIds: [DOC_A],
      actionItems: [{ description: "Loonstroken sturen", clarity: "clear" }],
    });
  });

  it("an edit overlays proposed, an attachment list replaces it", () => {
    const e = entryFromProposed(mailSuggestion, {
      occurredAt: "2026-10-30T08:00:00.000Z", channel: "call", summary: "Gebeld",
      participantPartyIds: [PARTY], attachmentDocumentIds: [DOC_B, DOC_B] });
    expect(e.occurredAt).toEqual(new Date("2026-10-30T08:00:00.000Z"));
    expect(e.channel).toBe("call");
    expect(e.direction).toBe("inbound");
    expect(e.summary).toBe("Gebeld");
    expect(e.participantPartyIds).toEqual([PARTY]);
    expect(e.documentIds).toEqual([DOC_B]);
  });

  it("refuses an edited source", () => {
    expect(() => entryFromProposed(mailSuggestion, { source: "manual" })).toThrow(ZodError);
  });

  it("refuses an unknown edit key and a wrongly typed edit", () => {
    expect(() => entryFromProposed(mailSuggestion, { documentIds: [DOC_B] })).toThrow(ZodError);
    expect(() => entryFromProposed(mailSuggestion, { channel: "telegram" })).toThrow(ZodError);
    expect(() => entryFromProposed(mailSuggestion, { summary: 3 })).toThrow(ZodError);
  });

  it("refuses a proposal that is not an entry", () => {
    expect(() => entryFromProposed({ ...mailSuggestion, proposed: null })).toThrow(ZodError);
  });

  it("source comes from the suggestion: voice is manual, everything else the mail watcher", () => {
    expect(entrySource({ promptVersion: "voice-v1" })).toBe("manual");
    expect(entrySource({ promptVersion: "entry-v1" })).toBe("gmail-watch");
    expect(entrySource({ promptVersion: null })).toBe("gmail-watch");
    expect(entryFromProposed({ rawEmailId: null, promptVersion: "voice-v1", proposed }).source)
      .toBe("manual");
  });
  it("a voice note carries the party Martin picked; a mined proposal never carries ids", () => {
    const voice = { rawEmailId: null, promptVersion: "voice-v1",
      proposed: { ...proposed, channel: "call", participantPartyIds: [PARTY] } };
    expect(entryFromProposed(voice).participantPartyIds).toEqual([PARTY]);
    // An edit still wins, an emptied list included.
    expect(entryFromProposed(voice, { participantPartyIds: [] }).participantPartyIds).toEqual([]);
    // The miner proposes names; ids in a mined payload are not trusted.
    expect(entryFromProposed({ ...mailSuggestion,
      proposed: { ...proposed, participantPartyIds: [PARTY] } }).participantPartyIds).toEqual([]);
  });
});
