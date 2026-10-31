import { mobileGet } from "@/lib/mobile-route";
import { toSuggestionDTO } from "@/lib/mobile-dto";

/** One suggestion for the phone's detail screen, by its effective document state. */
export const GET = mobileGet(async (caller, _req, { id }) =>
  toSuggestionDTO(await caller.suggestions.get({ id })));
