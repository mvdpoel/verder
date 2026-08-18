import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Db } from "@verder/db";

export function createAuth(opts: { db: Db; secret: string; baseURL: string }) {
  return betterAuth({
    database: drizzleAdapter(opts.db, { provider: "pg" }),
    secret: opts.secret,
    baseURL: opts.baseURL,
    // minPasswordLength relaxed from better-auth's default of 8: single-user
    // self-hosted v1 where Martin picks his own password.
    emailAndPassword: { enabled: true, minPasswordLength: 6 },
    // Single-user v1: sign-ups are disabled after seeding via env flag.
    ...(process.env.ALLOW_SIGNUP === "1" ? {} : { disabledPaths: ["/sign-up/email"] }),
  });
}
