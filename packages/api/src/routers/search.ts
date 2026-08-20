import { z } from "zod";
import { SEARCH_ENTITY_TYPES, SEARCH_STATUSES } from "@verder/core";
import { protectedProcedure, router } from "../trpc";
import { realEmbedPort } from "../search/embed";
import { realRerankPort } from "../search/rerank";
import { retrieve } from "../search/retrieve";

/** ISO date ("2026-01-31") or full ISO timestamp — both are what the /search filter
 * rail and the ⌘K palette produce. Validated here so a typo is a BAD_REQUEST and not
 * a Postgres cast error surfacing as INTERNAL_SERVER_ERROR. */
const isoDate = z.string().regex(
  /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/,
  "expected an ISO date like 2026-01-31",
);

export const searchRouter = router({
  /**
   * Hybrid retrieval. The input is FLAT — no `filters` wrapper — because /search
   * builds it straight from URL search params and the ⌘K palette from one text box.
   * The cursor is opaque: a base64 string, never a number.
   *
   * The rerank port is passed on every call; retrieve() only reaches for it when
   * mode is "deep", so ⌘K and /search never pay an Ollama round trip.
   */
  query: protectedProcedure.input(z.object({
    q: z.string().min(1).max(500),
    entityTypes: z.array(z.enum(SEARCH_ENTITY_TYPES)).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    partyId: z.string().uuid().optional(),
    status: z.enum(SEARCH_STATUSES).optional(),
    // "deep" costs an Ollama round trip: agent surfaces only, never ⌘K.
    mode: z.enum(["fast", "deep"]).default("fast"),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().nullish(),
  })).query(({ ctx, input }) => retrieve(
    { db: ctx.db, embed: realEmbedPort(), rerank: realRerankPort() },
    input,
  )),
});
