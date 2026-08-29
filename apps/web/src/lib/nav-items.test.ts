import { describe, expect, it } from "vitest";
import { NAV_ITEMS } from "@/lib/nav-items";

describe("NAV_ITEMS", () => {
  it("offers a way to reach security settings", () => {
    // Passkeys, devices and the password all live on /settings/security. It is
    // reachable only from the sidebar, so a missing entry means the only way
    // to revoke a device is to type the URL from memory.
    expect(NAV_ITEMS.map((i) => i.href)).toContain("/settings/security");
  });

  it("offers De zaak, which is where that work happens now", () => {
    expect(NAV_ITEMS).toContainEqual({ label: "De zaak", href: "/timeline" });
  });

  it("has no duplicate hrefs", () => {
    const hrefs = NAV_ITEMS.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
