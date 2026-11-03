import { mobileGet } from "@/lib/mobile-route";
import { toCaseMapDTO } from "@/lib/mobile-case-map";

/**
 * The case as a metro map, for the phone's Tijdlijn: the same `tracks.map`
 * call /timeline makes. `?schuldeisers=verborgen` is the web's own switch and
 * goes to the router as `hideDebtEpisodes`, which filters the map's INPUT —
 * never the built map — so bands, lanes and the current stop stay honest.
 * Any other value is the default (shown), as on the web.
 */
export const GET = mobileGet(async (caller, req) => {
  const hide = new URL(req.url).searchParams.get("schuldeisers") === "verborgen";
  const { map, evidence, hiddenDebtTrackCount } = await caller.tracks.map({ hideDebtEpisodes: hide });
  return toCaseMapDTO({ map, evidence, hiddenDebtTrackCount, debtEpisodesHidden: hide });
});
