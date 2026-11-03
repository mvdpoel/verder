import { describe, expect, it, vi } from "vitest";
import { loadAccount } from "./mobile-account";

const expiresAt = new Date("2026-12-01T09:00:00.000Z");
const now = new Date("2026-11-01T08:41:00.000Z");

describe("loadAccount", () => {
  it("answers the session's email, name, expiry and the passkey and device counts", async () => {
    const countPasskeys = vi.fn(async () => 2);
    const countSessions = vi.fn(async () => 3);
    const out = await loadAccount({
      getSession: async () => ({ user: { id: "u1", email: "martin@example.test", name: "Martin" }, session: { expiresAt } }),
      countPasskeys, countSessions, now: () => now,
    });
    expect(out).toEqual({ email: "martin@example.test", name: "Martin", passkeys: 2, sessionExpiresAt: expiresAt, devices: 3 });
    expect(countPasskeys).toHaveBeenCalledWith("u1");
    // Only the sessions still alive now: an expired row is no device.
    expect(countSessions).toHaveBeenCalledWith("u1", now);
  });

  it("an empty name is null, never an empty string the phone would draw", async () => {
    const out = await loadAccount({
      getSession: async () => ({ user: { id: "u1", email: "m@example.test", name: "" }, session: { expiresAt } }),
      countPasskeys: async () => 0, countSessions: async () => 1,
    });
    expect(out).toEqual({ email: "m@example.test", name: null, passkeys: 0, sessionExpiresAt: expiresAt, devices: 1 });
  });

  it("no session is null, and nothing is counted for nobody", async () => {
    const countPasskeys = vi.fn(async () => 1);
    const countSessions = vi.fn(async () => 1);
    expect(await loadAccount({ getSession: async () => null, countPasskeys, countSessions })).toBeNull();
    expect(countPasskeys).not.toHaveBeenCalled();
    expect(countSessions).not.toHaveBeenCalled();
  });
});
