import { mobileGet } from "@/lib/mobile-route";
import { toRequestDTO } from "@/lib/mobile-requests";

/**
 * One request: Martin's question, the answer, its sources, the steps only he
 * can do, the proposal card and the thread — and, while Grip works on it, live
 * progress read from the tool log ("leest 4 documenten, zoekt in Gmail"). The
 * phone polls this while the request is queued or working.
 */
export const GET = mobileGet(async (caller, _req, { id }) => toRequestDTO(await caller.requests.get({ id })));
