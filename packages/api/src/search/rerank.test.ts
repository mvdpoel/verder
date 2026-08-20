import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import {
  buildRerankPrompt, realRerankPort, RERANK_PROMPT_VERSION, RERANK_TIMEOUT_MS,
} from "./rerank";

let server: Server;
let baseUrl = "";
let lastPrompt = "";
let reply: unknown = { order: [1] };

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += String(c); });
    req.on("end", () => {
      const body = JSON.parse(raw) as { messages: { content: string }[] };
      lastPrompt = body.messages[0].content;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: { content: JSON.stringify(reply) } }));
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));

const candidates = [
  { id: "aaa", text: "Brief van Ziggo over de opzegging" },
  { id: "bbb", text: "Loonstrook juni" },
  { id: "ccc", text: "Bevestiging beëindiging abonnement" },
];

describe("rerank port (rerank-v1)", () => {
  it("pins the prompt version and the 20 s budget", () => {
    expect(RERANK_PROMPT_VERSION).toBe("rerank-v1");
    expect(RERANK_TIMEOUT_MS).toBe(20_000);
  });

  it("puts the query and every numbered candidate in the prompt", () => {
    const prompt = buildRerankPrompt("kopie paspoort", [
      { ref: 1, text: "Brief 1" }, { ref: 2, text: "Brief 2" },
    ]);
    expect(prompt).toContain("kopie paspoort");
    expect(prompt).toContain("[1] Brief 1");
    expect(prompt).toContain("[2] Brief 2");
  });

  it("sends that prompt to Ollama and maps the answer back to candidate ids", async () => {
    reply = { order: [3, 1, 2] };
    const scored = await realRerankPort({ url: baseUrl }).rerank("opzegging Ziggo", candidates);
    expect(lastPrompt).toContain("opzegging Ziggo");
    expect(lastPrompt).toContain("[3] Bevestiging beëindiging abonnement");
    expect(scored.map((s) => s.id)).toEqual(["ccc", "aaa", "bbb"]);
    // Descending score, so the caller can sort without knowing the order semantics.
    expect(scored[0].score).toBeGreaterThan(scored[1].score);
    expect(scored[1].score).toBeGreaterThan(scored[2].score);
  });

  it("drops refs the model repeated or invented", async () => {
    reply = { order: [3, 3, 0, 99, 2] };
    const scored = await realRerankPort({ url: baseUrl }).rerank("opzegging", candidates);
    expect(scored.map((s) => s.id)).toEqual(["ccc", "bbb"]);
  });

  it("throws when the endpoint is unreachable, so the caller can fall back", async () => {
    await expect(realRerankPort({ url: "http://127.0.0.1:1" }).rerank("opzegging", candidates))
      .rejects.toThrow();
  });
});
