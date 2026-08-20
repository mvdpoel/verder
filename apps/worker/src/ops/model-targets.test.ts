import { describe, expect, it } from "vitest";
import { modelTargets } from "./model-targets";

describe("modelTargets", () => {
  it("checks the chat model and the embedding model, with the project defaults", () => {
    expect(modelTargets({})).toEqual(["qwen3.5:9b", "nomic-embed-text"]);
  });

  it("honours both environment overrides", () => {
    expect(modelTargets({ OLLAMA_MODEL: "qwen3.5:14b", OLLAMA_EMBED_MODEL: "bge-m3" }))
      .toEqual(["qwen3.5:14b", "bge-m3"]);
  });

  it("deduplicates when both variables name the same tag", () => {
    expect(modelTargets({ OLLAMA_MODEL: "same:1", OLLAMA_EMBED_MODEL: "same:1" }))
      .toEqual(["same:1"]);
  });
});
