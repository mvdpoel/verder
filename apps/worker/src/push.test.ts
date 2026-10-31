import { describe, expect, it, vi } from "vitest";

// realTransport is the only thing left in push.ts: notify() owns the fan-out,
// the revocation of dead subscriptions and the recording of every attempt
// (notify/notify.test.ts). What is left to pin here is the VAPID wiring itself.
// web-push is mocked, so nothing is ever sent.
const wp = vi.hoisted(() => ({ setVapidDetails: vi.fn(), sendNotification: vi.fn(async () => ({ statusCode: 201 })) }));
vi.mock("web-push", () => ({ default: wp }));

import { realTransport } from "./push";

describe("realTransport", () => {
  it("sets the VAPID details from the environment and sends the subscription's keys", async () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "pub-key");
    vi.stubEnv("VAPID_PRIVATE_KEY", "priv-key");
    try {
      const t = realTransport();
      expect(wp.setVapidDetails).toHaveBeenCalledWith("mailto:martin@vanderpoel.pro", "pub-key", "priv-key");
      const r = await t.send({ endpoint: "https://push.example/x", p256dh: "k", auth: "a" }, "{\"title\":\"t\"}");
      expect(wp.sendNotification).toHaveBeenCalledWith(
        { endpoint: "https://push.example/x", keys: { p256dh: "k", auth: "a" } }, "{\"title\":\"t\"}");
      expect(r).toEqual({ statusCode: 201 });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("exports nothing that sends on its own", async () => {
    // The old sender dropped every non-404/410 error on the floor and recorded
    // nothing; every alert now goes through notify().
    expect(Object.keys(await import("./push")).sort()).toEqual(["realTransport"]);
  });
});
