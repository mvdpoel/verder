import { mobileGet } from "@/lib/mobile-route";
import { fail } from "@/lib/mobile-json";
import { loadAccount } from "@/lib/mobile-account";

/**
 * The signed-in account for Meer → Account on the phone: email, name and how
 * many passkeys the account holds. Auth first (`mobileGet`); a session that
 * ends between that check and this read answers 401 like any other.
 */
export const GET = mobileGet(async () => (await loadAccount()) ?? fail("unauthorized", 401));
