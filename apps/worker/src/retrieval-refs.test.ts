import { describe, expect, it } from "vitest";
import type { SearchHit } from "@verder/api/src/search/retrieve";
import { refsFromHits, retrieveRefsWith } from "./retrieval-refs";

const hit = (over: Partial<SearchHit> = {}): SearchHit => ({
  entityType: "document", entityId: "11111111-1111-1111-1111-111111111111",
  title: "Loonstrook juni", snippet: "x".repeat(500), occurredAt: null,
  status: "filed", score: 0.0312, matchedBy: "both", href: "/vault/11111111-1111-1111-1111-111111111111",
  ...over,
});

describe("refsFromHits", () => {
  it("keeps entityType, entityId, title, score and a snippet capped at 300 chars", () => {
    expect(refsFromHits([hit()])).toEqual([{
      entityType: "document", entityId: "11111111-1111-1111-1111-111111111111",
      title: "Loonstrook juni", score: 0.0312, snippet: "x".repeat(300),
    }]);
  });

  it("keeps at most five references", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      hit({ entityId: `2222222${i}-2222-2222-2222-222222222222`, title: `Doc ${i}` }));
    expect(refsFromHits(many)).toHaveLength(5);
    expect(refsFromHits(many)[4].title).toBe("Doc 4");
  });
});

describe("retrieveRefsWith", () => {
  it("returns an empty list rather than throwing when retrieval is unavailable", async () => {
    const refs = retrieveRefsWith(async () => { throw new Error("ollama down"); });
    expect(await refs("loonstroken juni")).toEqual([]);
  });

  it("passes the query through and maps the hits", async () => {
    const seen: string[] = [];
    const refs = retrieveRefsWith(async (q) => { seen.push(q); return { hits: [hit()] }; });
    expect(await refs("loonstroken juni")).toHaveLength(1);
    expect(seen).toEqual(["loonstroken juni"]);
  });
});
