import { mobileGet } from "@/lib/mobile-route";
import { fail } from "@/lib/mobile-json";
import { DOSSIER_TEXTS_MAX } from "@grip/api/src/routers/dossier-sync";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Extracted text for `?ids=a,b` (at most 20). Extraction runs after ingest and
 * appends no ledger event, so the delta cannot announce it: the phone keeps
 * the ids that synced with `hasText: false` and asks here. An id with no
 * readable text — or discarded, or purged — is simply absent from the answer.
 */
export const GET = mobileGet(async (caller, req) => {
  const raw = new URL(req.url).searchParams.get("ids") ?? "";
  const ids = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (ids.length === 0) return fail("ids is required", 400);
  if (ids.length > DOSSIER_TEXTS_MAX) return fail(`at most ${DOSSIER_TEXTS_MAX} ids`, 400);
  if (!ids.every((id) => UUID.test(id))) return fail("ids must be uuids", 400);
  return caller.dossierSync.texts({ ids: ids.map((id) => id.toLowerCase()) });
});
