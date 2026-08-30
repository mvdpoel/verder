"use client";
import { trpc } from "@/lib/trpc-client";
import { Button } from "@/components/ui";

// pushManager.subscribe wants the VAPID key as raw bytes in older browsers;
// converting the base64url string is universally safe.
function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function EnablePush() {
  const key = trpc.push.vapidPublicKey.useQuery();
  const subscribe = trpc.push.subscribe.useMutation();
  if (!key.data) return null;
  return (
    // Ghost, never primary: this sits on the dashboard next to the one thing
    // that screen actually wants pressed, and a second glow cancels the first.
    <Button variant="ghost" size="sm" onClick={async () => {
      const reg = await navigator.serviceWorker.register("/sw.js");
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key.data!) });
      const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
      subscribe.mutate(json);
    }}>🔔 Waarschuw me als er iets te beoordelen is</Button>
  );
}
