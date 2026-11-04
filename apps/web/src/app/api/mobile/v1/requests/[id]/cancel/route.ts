import { mobilePost } from "@/lib/mobile-route";

/** Stop a queued or working request. The runner checks the status before it
 *  stores, so an answer that arrives afterwards is discarded. 409 once answered. */
export const POST = mobilePost(async (caller, _body, { id }) => caller.requests.cancel({ id }));
