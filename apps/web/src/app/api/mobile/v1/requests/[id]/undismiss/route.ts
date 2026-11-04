import { mobilePost } from "@/lib/mobile-route";

/** The toast's "Ongedaan maken" after "Laat maar": back in Voor jou as it was. */
export const POST = mobilePost(async (caller, _body, { id }) => caller.requests.undismiss({ id }));
