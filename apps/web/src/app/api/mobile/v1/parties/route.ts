import { mobileGet } from "@/lib/mobile-route";
import { fail } from "@/lib/mobile-json";

/**
 * The parties the phone's voice quick-log picks from (Plan 3 Task 24).
 * `?recent=1`: the one Martin was most recently in contact with first (newest
 * log entry it took part in), then by name. Without it: by name. Hand-shaped,
 * never raw router output — an email address or a note is not the picker's
 * business.
 */
export const GET = mobileGet(async (caller, req) => {
  const recent = new URL(req.url).searchParams.get("recent");
  if (recent !== null && recent !== "1") return fail("recent must be 1", 400);
  const rows = await caller.parties.recent();
  const dto = rows.map((p) => ({
    id: p.id, kind: p.kind, name: p.name, organization: p.organization,
    lastContactAt: p.lastContactAt ? p.lastContactAt.toISOString() : null,
  }));
  return recent === "1" ? dto : dto.sort((a, b) => a.name.localeCompare(b.name, "nl"));
});
