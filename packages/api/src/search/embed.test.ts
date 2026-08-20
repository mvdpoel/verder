import { describe, expect, it } from "vitest";
import { asDocument, asQuery, EMBED_DIMENSIONS, EMBED_MODEL_ENV } from "./embed";

describe("nomic task prefixes", () => {
  it("prefixes stored text with search_document and query text with search_query", () => {
    // nomic-embed-text is asymmetric. Indexing with one prefix and querying with
    // the other silently halves recall — no error, just worse results — so the
    // two prefixes exist as functions rather than as inline string literals.
    expect(asDocument("Opzegging Ziggo")).toBe("search_document: Opzegging Ziggo");
    expect(asQuery("opzegging ziggo")).toBe("search_query: opzegging ziggo");
  });
});

describe("embedding constants", () => {
  it("declares the 768 dimensions the vector column is sized for", () => {
    expect(EMBED_DIMENSIONS).toBe(768);
  });

  it("names the env var that selects the embedding model", () => {
    expect(EMBED_MODEL_ENV).toBe("OLLAMA_EMBED_MODEL");
  });
});
