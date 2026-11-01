import { mobileGet } from "@/lib/mobile-route";
import { fail } from "@/lib/mobile-json";
import { toSearchDTO } from "@/lib/mobile-dto";

/** search.query's own bound on `q`. */
const MAX_Q = 500;

/**
 * "Zoek op de server" from the Dossier tab: `search.query` in FAST mode only —
 * deep mode costs an Ollama rerank and is for agent surfaces, never a text
 * box. Hits carry an app route (`verder://document/<id>`, `verder://task/<id>`)
 * in place of the web `href`, or `null` for a kind the phone has no screen for.
 */
export const GET = mobileGet(async (caller, req) => {
  const params = new URL(req.url).searchParams;
  const q = (params.get("q") ?? "").trim();
  if (q === "" || q.length > MAX_Q) return fail(`q must be 1..${MAX_Q} characters`, 400);
  const cursor = params.get("cursor");
  const out = await caller.search.query({ q, mode: "fast", limit: 20, cursor: cursor || null });
  return toSearchDTO(out);
});
