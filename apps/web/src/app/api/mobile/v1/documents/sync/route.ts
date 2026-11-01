import { mobileGet } from "@/lib/mobile-route";
import { fail } from "@/lib/mobile-json";
import { DOSSIER_PAGE_MAX } from "@verder/api/src/routers/dossier-sync";

/** A non-negative integer as a query parameter, or null. Digits only: "1.5",
 *  "1e3" and "-1" are refused, never rounded into a cursor the phone did not send. */
function intParam(raw: string | null, fallback: number): number | null {
  if (raw === null) return fallback;
  if (!/^\d{1,15}$/.test(raw)) return null;
  return Number(raw);
}

/**
 * The pocket dossier's delta (`dossierSync.delta`): every document touched
 * since `?cursor=` (a ledger seq), each as what it IS now — an upsert, or a
 * tombstone when it was discarded or purged. The phone stores the returned
 * cursor only after it has applied the page, and asks again while `more`.
 */
export const GET = mobileGet(async (caller, req) => {
  const params = new URL(req.url).searchParams;
  const cursor = intParam(params.get("cursor"), 0);
  const limit = intParam(params.get("limit"), DOSSIER_PAGE_MAX);
  if (cursor === null) return fail("cursor must be a non-negative integer", 400);
  if (limit === null || limit < 1 || limit > DOSSIER_PAGE_MAX)
    return fail(`limit must be 1..${DOSSIER_PAGE_MAX}`, 400);
  return caller.dossierSync.delta({ cursor, limit });
});
