import { createAuth } from "@grip/auth";
import { getDb } from "./db";

// One better-auth instance per process (shares the singleton db pool).
const g = globalThis as unknown as { __gripAuth?: ReturnType<typeof createAuth> };

export function getAuth(): ReturnType<typeof createAuth> {
  g.__gripAuth ??= createAuth({
    db: getDb().db,
    secret: process.env.AUTH_SECRET!,
    baseURL: process.env.APP_URL ?? "http://localhost:3000",
    trustedOrigins: (process.env.TRUSTED_ORIGINS ?? "").split(",").filter(Boolean),
    // A passkey is bound to its rpID, so one registered against localhost
    // will never work against grip.vanderpoel.pro. That is WebAuthn
    // behaving correctly; the production passkey is registered in production.
    rpID: process.env.PASSKEY_RP_ID ?? "localhost",
    rpName: process.env.PASSKEY_RP_NAME ?? "Verder",
  });
  return g.__gripAuth;
}
