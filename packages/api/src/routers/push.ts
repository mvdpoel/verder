import { z } from "zod";
import { sql } from "drizzle-orm";
import { schema } from "@verder/db";
import { protectedProcedure, publicProcedure, router } from "../trpc";

/**
 * What the phone sends to register for APNs. The token is lowercase hex
 * (`hexToken` on the phone); anything else is a client bug, refused here
 * rather than stored as an address APNs will answer `BadDeviceToken` to.
 */
export const registerDeviceInput = z.object({
  token: z.string().regex(/^[0-9a-f]{64,200}$/),
  environment: z.enum(["development", "production"]),
  bundleId: z.literal("pro.vanderpoel.verder"),
  appVersion: z.string().min(1).max(40),
  // REQUIRED, unlike the plan's `.optional()`: `push_devices.session_id` is
  // NOT NULL and notify() delivers only to a device whose session is live, so
  // a registration without one would be stored and then never receive a push.
  // The mobile route fills it from the better-auth session, never the body.
  sessionId: z.string().min(1),
});

export const pushRouter = router({
  vapidPublicKey: publicProcedure.query(() => process.env.VAPID_PUBLIC_KEY ?? null),
  subscribe: protectedProcedure.input(z.object({
    endpoint: z.string().url(),
    keys: z.object({ p256dh: z.string(), auth: z.string() }),
  })).mutation(async ({ ctx, input }) => {
    await ctx.db.insert(schema.pushSubscriptions)
      .values({ endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth })
      .onConflictDoUpdate({ target: schema.pushSubscriptions.endpoint,
        set: { p256dh: input.keys.p256dh, auth: input.keys.auth, revoked: false } });
    return { ok: true };
  }),

  /**
   * Upsert on the APNs token. A device is a delivery address, not evidence:
   * no ledger event. Re-registering clears a revocation (a 410 that the phone
   * answers with a fresh registration, or a re-sign-in after a lost-phone
   * revoke) and moves the device to the session it registered under now.
   */
  registerDevice: protectedProcedure.input(registerDeviceInput)
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.db.insert(schema.pushDevices).values({
        token: input.token, environment: input.environment, bundleId: input.bundleId,
        appVersion: input.appVersion, sessionId: input.sessionId,
      }).onConflictDoUpdate({
        target: schema.pushDevices.token,
        set: {
          environment: input.environment, bundleId: input.bundleId,
          appVersion: input.appVersion, sessionId: input.sessionId,
          lastSeenAt: sql`now()`, revokedAt: null, revokedReason: null,
        },
      }).returning({ id: schema.pushDevices.id });
      return { id: row.id };
    }),
});
