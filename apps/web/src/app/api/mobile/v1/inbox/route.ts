import { mobileGet } from "@/lib/mobile-route";
import { toInboxDTO } from "@/lib/mobile-dto";

/**
 * Everything waiting on Martin, ranked (spec §7.2, §12.9): the one definition
 * in packages/api/src/waiting.ts. `count` is the list's own length.
 */
export const GET = mobileGet(async (caller) => toInboxDTO(await caller.inbox.list()));
