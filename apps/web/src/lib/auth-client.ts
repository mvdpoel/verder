import { createAuthClient } from "better-auth/react";
import { passkeyClient } from "@better-auth/passkey/client";

/**
 * The one auth client the browser uses. Both the login page and the security
 * settings page import it; creating a second one would give the two pages
 * separate nanostores and a stale passkey list after every add or remove.
 */
export const authClient = createAuthClient({
  plugins: [passkeyClient()],
});
