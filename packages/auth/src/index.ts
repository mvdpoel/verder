import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Db } from "@verder/db";

export function createAuth(opts: { db: Db; secret: string; baseURL: string; trustedOrigins?: string[] }) {
  return betterAuth({
    database: drizzleAdapter(opts.db, { provider: "pg" }),
    secret: opts.secret,
    baseURL: opts.baseURL,
    // Extra origins allowed to hit auth endpoints (e.g. LAN IP while the
    // public hostname is the canonical baseURL). Comes from TRUSTED_ORIGINS.
    ...(opts.trustedOrigins?.length ? { trustedOrigins: opts.trustedOrigins } : {}),
    // minPasswordLength relaxed from better-auth's default of 8: single-user
    // self-hosted v1 where Martin picks his own password.
    emailAndPassword: { enabled: true, minPasswordLength: 6 },
    // Single-user v1: sign-ups are disabled after seeding via env flag.
    ...(process.env.ALLOW_SIGNUP === "1" ? {} : { disabledPaths: ["/sign-up/email"] }),
  });
}
