import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { passkey } from "@better-auth/passkey";
import type { Db } from "@verder/db";
import { TRUSTED_SESSION_SECONDS, sessionExpiryFor } from "./session-trust";

export function createAuth(opts: {
  db: Db;
  secret: string;
  baseURL: string;
  trustedOrigins?: string[];
  rpID?: string;
  rpName?: string;
}) {
  return betterAuth({
    database: drizzleAdapter(opts.db, { provider: "pg" }),
    secret: opts.secret,
    baseURL: opts.baseURL,
    // Extra origins allowed to hit auth endpoints (e.g. LAN IP while the
    // public hostname is the canonical baseURL). Comes from TRUSTED_ORIGINS.
    ...(opts.trustedOrigins?.length ? { trustedOrigins: opts.trustedOrigins } : {}),
    // Raised from 6 now that the login form faces the open internet rather
    // than sitting behind Cloudflare Access. This governs sign-up and
    // change-password only — better-auth does not re-check length on sign-in,
    // so raising it cannot lock anyone out of an existing password.
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    // Single-user v1: sign-ups are disabled after seeding via env flag.
    ...(process.env.ALLOW_SIGNUP === "1" ? {} : { disabledPaths: ["/sign-up/email"] }),
    plugins: [
      passkey({
        rpID: opts.rpID ?? "localhost",
        rpName: opts.rpName ?? "Verder",
        origin: opts.baseURL,
      }),
    ],
    // The ceiling. The hook below shortens individual sessions; this is what
    // a trusted one gets and what the session cookie's max-age is built from.
    session: {
      expiresIn: TRUSTED_SESSION_SECONDS,
      updateAge: 60 * 60 * 24, // roll the expiry at most once a day
    },
    databaseHooks: {
      session: {
        create: {
          /**
           * The one place both sign-in paths meet.
           *
           * `signIn.email` accepts `rememberMe: false`, which really does
           * shorten the row (internal-adapter.mjs: expiresAt = 1 day) — but
           * the passkey plugin calls createSession(userId, void 0, …), so
           * dontRememberMe is always undefined there and a passkey sign-in
           * would otherwise always get the full 30 days. Deciding here covers
           * both, identically, and keeps the choice in one readable place.
           */
          before: async (session, context) => ({
            data: {
              ...session,
              // Mirrors how internalAdapter.createSession itself reaches for
              // headers — the shape differs between call sites.
              expiresAt: sessionExpiryFor(context?.headers ?? context?.request?.headers),
            },
          }),
        },
      },
    },
    rateLimit: {
      // better-auth enables this in production only by default. Turn it on
      // everywhere so the behaviour under test is the behaviour in prod.
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/passkey/verify-authentication": { window: 60, max: 10 },
        "/change-password": { window: 60, max: 5 },
      },
    },
    advanced: {
      // Behind the cloudflared tunnel every request arrives from the tunnel
      // itself, and better-auth's default is ["x-forwarded-for"] — which a
      // client can prepend to, handing itself a fresh rate-limit bucket per
      // request and defeating the rules above. Cloudflare sets and overwrites
      // cf-connecting-ip, so it is both correct and unspoofable. It is also
      // what makes the IP in the device list mean anything.
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"] },
    },
  });
}
