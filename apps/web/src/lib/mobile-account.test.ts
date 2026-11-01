import { describe, expect, it, vi } from "vitest";
import { loadAccount } from "./mobile-account";

describe("loadAccount", () => {
  it("answers the session's email, name and passkey count", async () => {
    const countPasskeys = vi.fn(async () => 2);
    const out = await loadAccount({
      getSession: async () => ({ user: { id: "u1", email: "martin@example.test", name: "Martin" } }),
      countPasskeys,
    });
    expect(out).toEqual({ email: "martin@example.test", name: "Martin", passkeys: 2 });
    expect(countPasskeys).toHaveBeenCalledWith("u1");
  });

  it("an empty name is null, never an empty string the phone would draw", async () => {
    const out = await loadAccount({
      getSession: async () => ({ user: { id: "u1", email: "m@example.test", name: "" } }),
      countPasskeys: async () => 0,
    });
    expect(out).toEqual({ email: "m@example.test", name: null, passkeys: 0 });
  });

  it("no session is null, and the passkeys are never counted for nobody", async () => {
    const countPasskeys = vi.fn(async () => 1);
    expect(await loadAccount({ getSession: async () => null, countPasskeys })).toBeNull();
    expect(countPasskeys).not.toHaveBeenCalled();
  });
});
