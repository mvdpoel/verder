import { afterEach, describe, expect, it, vi } from "vitest";
import {
  asDocument, asQuery, EMBED_DIMENSIONS, EMBED_MODEL_ENV, realEmbedPort,
} from "./embed";

const vec = (n: number) => Array.from({ length: EMBED_DIMENSIONS }, () => n);
const ok = (embeddings: number[][]) =>
  new Response(JSON.stringify({ embeddings }), { status: 200 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("nomic task prefixes", () => {
  it("prefixes stored text with search_document and queries with search_query", () => {
    // nomic-embed-text is asymmetric: the wrong prefix silently costs recall,
    // and nothing about the results looks broken when it happens.
    expect(EMBED_MODEL_ENV).toBe("OLLAMA_EMBED_MODEL");
    expect(asDocument("Opzegging Ziggo")).toBe("search_document: Opzegging Ziggo");
    expect(asQuery("opzegging ziggo")).toBe("search_query: opzegging ziggo");
  });
});

describe("realEmbedPort", () => {
  it("posts to /api/embed with the configured url and model and an abort signal", async () => {
    const fetchMock = vi.fn(async () => ok([vec(1)]));
    vi.stubGlobal("fetch", fetchMock);
    await realEmbedPort({ url: "http://gpu.local:11434", model: "nomic-embed-text" })
      .embed(["search_document: hallo"]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://gpu.local:11434/api/embed");
    const body = JSON.parse(String(init.body)) as { model: string; input: string[] };
    expect(body.model).toBe("nomic-embed-text");
    expect(body.input).toEqual(["search_document: hallo"]);
    // Without this the drain can hang forever on a wedged Ollama.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reads the model from OLLAMA_EMBED_MODEL when no model is passed", async () => {
    const fetchMock = vi.fn(async () => ok([vec(1)]));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv(EMBED_MODEL_ENV, "nomic-embed-text:v1.5");
    await realEmbedPort().embed(["a"]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((JSON.parse(String(init.body)) as { model: string }).model)
      .toBe("nomic-embed-text:v1.5");
  });

  it("returns one vector per text, in order", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok([vec(1), vec(2)])));
    const out = await realEmbedPort().embed(["a", "b"]);
    expect(out).toHaveLength(2);
    expect(out[0]![0]).toBe(1);
    expect(out[1]![0]).toBe(2);
  });

  it("splits into batches of 16 and never runs more than 2 in flight", async () => {
    // Ollama on the homelab is shared with qwen3.5:9b (suggest.entry,
    // registry.mine and three evals); a stampede here starves those.
    let inFlight = 0;
    let peak = 0;
    const sizes: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      sizes.push(body.input.length);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return ok(body.input.map(() => vec(3)));
    }));
    const out = await realEmbedPort().embed(Array.from({ length: 40 }, (_, i) => `t${i}`));
    expect(out).toHaveLength(40);
    expect(out.every((v) => v !== null)).toBe(true);
    expect(sizes).toEqual([16, 16, 8]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("retries a failing batch with backoff and succeeds", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      n++;
      if (n === 1) return new Response("boom", { status: 500 });
      return ok([vec(4)]);
    }));
    const out = await realEmbedPort().embed(["a"]); // ~250 ms of real backoff
    expect(n).toBe(2);
    expect(out[0]![0]).toBe(4);
  });

  it("gives up after three attempts and returns null — chunks stay lexically searchable", async () => {
    const fetchMock = vi.fn(async () => new Response("down", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await realEmbedPort().embed(["a"]); // ~750 ms of real backoff
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(out).toEqual([null]);
  });

  it("rejects a wrong-width reply rather than storing a corrupt vector", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok([[1, 2, 3]])));
    const out = await realEmbedPort().embed(["a"]);
    expect(out).toEqual([null]);
  });
});
