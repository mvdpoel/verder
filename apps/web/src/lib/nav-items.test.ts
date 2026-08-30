import { describe, expect, it } from "vitest";
import { activeNavHref, NAV_ITEMS } from "@/lib/nav-items";

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

describe("activeNavHref", () => {
  it("marks the destination you are actually on", () => {
    expect(activeNavHref("/dashboard")).toBe("/dashboard");
    expect(activeNavHref("/timeline")).toBe("/timeline");
  });

  it("keeps the rail lit on a detail page", () => {
    // The rail going dark the moment you open an entry is the failure this
    // whole function exists to prevent: eleven unlabelled icons and no mark.
    expect(activeNavHref("/logbook/2f9c-uuid")).toBe("/logbook");
    expect(activeNavHref("/logbook/new")).toBe("/logbook");
    expect(activeNavHref("/registry/debts/abc")).toBe("/registry");
    expect(activeNavHref("/settings/security")).toBe("/settings/security");
  });

  it("breaks only on a slash", () => {
    // Plain startsWith would light Tasks here, which is a different page.
    expect(activeNavHref("/tasks-archive")).toBeNull();
  });

  it("prefers the longest match when destinations nest", () => {
    const items = [{ label: "A", href: "/registry" }, { label: "B", href: "/registry/debts" }];
    expect(activeNavHref("/registry/debts/abc", items)).toBe("/registry/debts");
  });

  it("returns null for a page that is on no destination", () => {
    expect(activeNavHref("/login")).toBeNull();
  });
});
