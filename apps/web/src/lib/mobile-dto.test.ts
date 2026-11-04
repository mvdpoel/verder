import { describe, expect, it } from "vitest";
import type { WaitingItem } from "@grip/api/src/waiting";
import {
  toDashboardSummaryDTO, toInboxDTO, toSuggestionDTO, toTaskDTO,
  type SuggestionSource,
} from "./mobile-dto";

const DOC_ID = "5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

function suggestion(over: Partial<SuggestionSource> = {}): SuggestionSource {
  return {
    id: "s-1", kind: "document-meta", status: "pending",
    createdAt: new Date("2026-10-30T08:15:00.000Z"),
    proposed: { title: "Beschikking" }, retrievedRefs: null,
    rawEmail: null,
    document: {
      id: DOC_ID, status: "inbox",
      effectiveStatus: "discarded", effectiveTitle: "Beschikking rechtbank",
      effectiveDocType: "beschikking",
    },
    ...over,
  };
}

const item = (id: string): WaitingItem => ({
  kind: "task", id, title: `Taak ${id}`, subtitle: null, priority: 3,
  at: "2026-10-30T08:00:00.000Z", dueAt: null, verder: false,
});

describe("toSuggestionDTO", () => {
  it("toSuggestionDTO never leaks raw documents.status", () => {
    const dto = toSuggestionDTO(suggestion());
    // documents.status reads "inbox" forever; a discard lives only in the
    // change rows, so the phone must get the effective status.
    expect(dto.document).toEqual({
      id: DOC_ID, title: "Beschikking rechtbank", docType: "beschikking", status: "discarded",
    });
    expect(JSON.stringify(dto)).not.toContain("inbox");
  });

  it("dates serialise as ISO strings", () => {
    const dto = toSuggestionDTO(suggestion({
      rawEmail: { fromAddr: "demi@verdergroep.nl", subject: "Stukken",
        sentAt: new Date("2026-10-29T13:00:00.000Z") },
    }));
    expect(dto.createdAt).toBe("2026-10-30T08:15:00.000Z");
    expect(dto.trigger).toEqual({
      from: "demi@verdergroep.nl", subject: "Stukken", sentAt: "2026-10-29T13:00:00.000Z",
    });
    const roundTrip = JSON.parse(JSON.stringify(dto));
    expect(roundTrip).toEqual(dto);
  });

  it("names every field and nothing else", () => {
    const dto = toSuggestionDTO(suggestion({ document: null }));
    expect(Object.keys(dto).sort()).toEqual(
      ["createdAt", "document", "id", "kind", "proposed", "retrievedRefs", "status", "trigger"]);
    expect(dto.trigger).toBeNull();
    expect(dto.document).toBeNull();
    // A NULL retrieved_refs column is an empty list on the wire.
    expect(dto.retrievedRefs).toEqual([]);
  });
});

describe("toInboxDTO", () => {
  it("inbox count equals items length", () => {
    const dto = toInboxDTO([item("a"), item("b"), item("c")]);
    expect(dto.count).toBe(3);
    expect(dto.todo + dto.review).toBe(dto.count);
    expect(dto.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(dto.doneByGrip).toEqual([]);
  });
});

describe("toTaskDTO", () => {
  it("uses the effective status and an ISO due date", () => {
    const dto = toTaskDTO({
      id: "t-1", title: "Loonstroken sturen", details: null,
      dueAt: new Date("2026-11-02T23:00:00.000Z"), status: "open",
      effectiveStatus: "in-progress", assigneeName: "Martin",
    }, ["waiting", "done"]);
    expect(dto).toEqual({
      id: "t-1", title: "Loonstroken sturen", details: null, dueAt: "2026-11-02T23:00:00.000Z",
      status: "in-progress", assigneeName: "Martin", validNext: ["waiting", "done"],
    });
  });
});

describe("toDashboardSummaryDTO", () => {
  const stats = { openCount: 2, overdueCount: 1, waitingOnOthersCount: 0 };

  it("summary headline is null when no stop is open", () => {
    const dto = toDashboardSummaryDTO({
      map: { currentStopId: null, stops: [], tracks: [] }, stats, waitingCount: 4,
    });
    expect(dto).toEqual({ headline: null, waitingCount: 4, tasks: stats });
  });

  it("headline names the current stop and its track", () => {
    const dto = toDashboardSummaryDTO({
      map: {
        currentStopId: "stop-2",
        stops: [
          { id: "stop-1", trackId: "tr-1", title: "Eerder", note: null, happenedAt: null },
          { id: "stop-2", trackId: "tr-2", title: "Stukken aanleveren", note: "Bij Verder",
            happenedAt: new Date("2026-08-28T10:00:00.000Z") },
        ],
        tracks: [{ id: "tr-1", title: "Bewindvoering" }, { id: "tr-2", title: "Opstartstukken" }],
      },
      stats, waitingCount: 1,
    });
    expect(dto.headline).toEqual({
      stopTitle: "Stukken aanleveren", trackTitle: "Opstartstukken",
      happenedAt: "2026-08-28T10:00:00.000Z", note: "Bij Verder",
    });
  });
});
