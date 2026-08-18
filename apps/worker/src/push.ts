import webpush from "web-push";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@verder/db";

export interface PushTransport {
  send(sub: { endpoint: string; p256dh: string; auth: string }, payload: string): Promise<unknown>;
}

export function realTransport(): PushTransport {
  webpush.setVapidDetails("mailto:martin@vanderpoel.pro",
    process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
  return { send: (sub, payload) => webpush.sendNotification(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload) };
}

export async function sendPush(db: Db, payload: { title: string; body: string },
  transport: PushTransport = realTransport()): Promise<void> {
  const subs = await db.select().from(schema.pushSubscriptions)
    .where(eq(schema.pushSubscriptions.revoked, false));
  for (const sub of subs) {
    try { await transport.send(sub, JSON.stringify(payload)); }
    catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410)
        await db.update(schema.pushSubscriptions).set({ revoked: true })
          .where(eq(schema.pushSubscriptions.id, sub.id));
    }
  }
}
