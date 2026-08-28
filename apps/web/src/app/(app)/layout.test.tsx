import { beforeEach, describe, expect, it, vi } from "vitest";

const getSessionUserId = vi.fn();
// Typed with the url parameter it is actually called with, so that
// `toHaveBeenCalledWith("/login")` below is checked rather than assumed.
const redirect = vi.fn((_url: string): never => { throw new Error("NEXT_REDIRECT"); });

vi.mock("@/lib/trpc-server", () => ({ getSessionUserId: () => getSessionUserId() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));
vi.mock("@/components/command-palette", () => ({ CommandPalette: () => null }));

import AppLayout from "./layout";

describe("app layout session guard", () => {
  beforeEach(() => {
    getSessionUserId.mockReset();
    redirect.mockClear();
  });

  it("sends a request with no valid session to the login page", async () => {
    getSessionUserId.mockResolvedValue(null);
    await expect(AppLayout({ children: null })).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/login");
  });

  it("renders for a valid session", async () => {
    getSessionUserId.mockResolvedValue("user-1");
    await AppLayout({ children: null });
    expect(redirect).not.toHaveBeenCalled();
  });
});
