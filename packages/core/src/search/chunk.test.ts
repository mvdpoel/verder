import { describe, expect, it } from "vitest";
import { chunkBody, CHUNK_SIZE, CHUNK_OVERLAP } from "./chunk";

describe("chunkBody", () => {
  it("returns a short body as exactly one chunk", () => {
    expect(chunkBody("Naam: Ziggo. Status: op te zeggen."))
      .toEqual(["Naam: Ziggo. Status: op te zeggen."]);
  });

  it("returns one empty chunk for an empty body", () => {
    // A record with no body text (a bare timeline event) must still be indexed:
    // the title is indexed alongside the body, so chunk 0 always exists.
    expect(chunkBody("")).toEqual([""]);
    expect(chunkBody("   \n\n  ")).toEqual([""]);
  });

  it("keeps a body of exactly the chunk size in one chunk, and splits one character more", () => {
    expect(chunkBody("a".repeat(CHUNK_SIZE))).toHaveLength(1);
    const two = chunkBody("a".repeat(CHUNK_SIZE + 1));
    expect(two.map((c) => c.length)).toEqual([CHUNK_SIZE, CHUNK_OVERLAP + 1]);
  });

  it("cuts on a paragraph boundary and overlaps into the next chunk", () => {
    const first = "A".repeat(700);
    const second = "B".repeat(700);
    const chunks = chunkBody(`${first}\n\n${second}`);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(first);
    expect(chunks[1].startsWith("A".repeat(CHUNK_OVERLAP))).toBe(true);
    expect(chunks[1].endsWith(second)).toBe(true);
  });

  it("never splits a code point", () => {
    const chunks = chunkBody("é👍".repeat(800)); // 1600 code points
    expect(Array.from(chunks[0])).toHaveLength(CHUNK_SIZE);
    expect(chunks[0].endsWith("👍")).toBe(true);
    expect(chunks.join("")).not.toMatch(/\uFFFD/);
    for (const c of chunks) expect(/[\uD800-\uDBFF]$/.test(c)).toBe(false);
  });
});
