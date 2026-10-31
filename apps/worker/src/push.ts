// The VAPID web-push transport. Sending, revoking dead subscriptions and
// recording every attempt is notify()'s job (notify/notify.ts); this file only
// builds the transport it sends through.
import webpush from "web-push";

export interface PushTransport {
  send(sub: { endpoint: string; p256dh: string; auth: string }, payload: string): Promise<unknown>;
}

export function realTransport(): PushTransport {
  webpush.setVapidDetails("mailto:martin@vanderpoel.pro",
    process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
  return { send: (sub, payload) => webpush.sendNotification(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload) };
}
