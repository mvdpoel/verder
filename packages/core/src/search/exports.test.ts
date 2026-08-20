import { describe, expect, it } from "vitest";
import {
  CHUNK_OVERLAP, CHUNK_SIZE, RRF_K, SEARCH_ENTITY_TYPES, SEARCH_STATUSES,
  chunkBody, rrfFuse, sourceHash,
} from "../index";

describe("@verder/core public surface", () => {
  it("re-exports every search primitive consumers import by package name", () => {
    expect(SEARCH_ENTITY_TYPES).toHaveLength(9);
    expect(SEARCH_STATUSES).toHaveLength(17);
    expect(CHUNK_SIZE).toBe(1200);
    expect(CHUNK_OVERLAP).toBe(150);
    expect(RRF_K).toBe(60);
    expect(chunkBody("kort")).toEqual(["kort"]);
    expect(sourceHash("t", "b")).toMatch(/^[0-9a-f]{64}$/);
    expect(rrfFuse([{ id: "a", rank: 1 }], [])).toHaveLength(1);
  });
});
