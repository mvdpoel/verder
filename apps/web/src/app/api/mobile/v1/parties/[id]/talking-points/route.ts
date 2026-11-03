import { mobileGet } from "@/lib/mobile-route";
import { fail } from "@/lib/mobile-json";
import { toTalkingPointsDTO } from "@/lib/mobile-talking-points";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What to tell and what to ask a party during a call (Added 2026-11-03,
 * Martin). iOS lets no third-party app hear or record a phone call, and
 * CXCallObserver says only THAT a call is on — so the phone shows the dossier
 * instead: deterministic points, each linked to its record, plus one AI line
 * once the homelab drafter has written it. Auth FIRST (`mobileGet`), JSON 401,
 * `no-store`; 404 for an unknown party, 400 for an id that is not one.
 */
export const GET = mobileGet(async (caller, _req, params) => {
  const id = params.id ?? "";
  if (!UUID.test(id)) return fail("id must be a uuid", 400);
  return toTalkingPointsDTO(await caller.parties.talkingPoints({ id }));
});
