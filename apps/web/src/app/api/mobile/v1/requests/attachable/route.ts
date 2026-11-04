import { mobileGet } from "@/lib/mobile-route";

/** "Koppel een stuk": the newest mail, document, party, stop and task, for the
 *  picker's RECENT list. The rest is found through `/search`. */
export const GET = mobileGet(async (caller) => ({ items: await caller.requests.attachable() }));
