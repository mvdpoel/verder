import { z } from "zod";
import { mobileGet, mobilePost } from "@/lib/mobile-route";
import { toRequestListItemDTO } from "@/lib/mobile-requests";

/**
 * Vraag Grip. GET: the phone's request list — queued, working, answered not
 * yet opened, and the last week's read answers and failures. POST: a new
 * request in Martin's own words, IDEMPOTENT on `clientId` (a retry after a
 * lost response returns the same request), optionally about one item and/or
 * following up an earlier answer. Nothing here researches anything: the host
 * runner claims it within a minute.
 */
export const GET = mobileGet(async (caller) => ({
  requests: (await caller.requests.list()).map(toRequestListItemDTO),
}));

const UUID = z.string().uuid();
const postBody = z.object({
  clientId: UUID,
  text: z.string().trim().min(1).max(4000),
  about: z.object({ rawEmailId: UUID, documentId: UUID, partyId: UUID, stopId: UUID, taskId: UUID })
    .partial().strict().nullish(),
  parentRequestId: UUID.nullish(),
}).strict();

export const POST = mobilePost(async (caller, body) => {
  const r = await caller.requests.create(postBody.parse(body));
  return { id: r.id, status: r.status, duplicate: r.duplicate };
});
