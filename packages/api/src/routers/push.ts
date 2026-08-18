import { z } from "zod";
import { schema } from "@verder/db";
import { protectedProcedure, publicProcedure, router } from "../trpc";

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
});
