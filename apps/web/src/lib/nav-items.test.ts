import { describe, expect, it } from "vitest";
import { DEAD_ENDS, NAV_ITEMS } from "@/lib/nav-items";

describe("NAV_ITEMS", () => {
  it("never points at a page whose edits do nothing", () => {
    // /milestones still responds and is still writable, but sub-project 6
    // replaced the milestone model with tracks and stops and nothing reads it
    // any more. A sidebar link to it is an invitation to lose work.
    for (const dead of DEAD_ENDS) {
      expect(NAV_ITEMS.map((i) => i.href)).not.toContain(dead);
    }
  });

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
