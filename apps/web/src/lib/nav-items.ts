/**
 * The sidebar, as data.
 *
 * It lives here rather than inline in `(app)/layout.tsx` so one rule can be
 * asserted without rendering: the sidebar never points Martin at a page whose
 * edits do nothing.
 *
 * `/milestones` is the reason this file exists. Sub-project 6 replaced the
 * milestone model with tracks and stops, and nothing reads `milestones` any
 * more — but the page is still there and still writable. Sending him there
 * would be sending him somewhere his edits vanish, which is worse than not
 * having the page at all. The page and its router are left standing on purpose
 * (nothing here deletes a table or a route in the same change that stops
 * reading it); the sidebar just stops pointing at it. "De zaak" is where that
 * work happens now.
 */

export type NavItem = { label: string; href: string };

/** Routes that still respond but that nothing reads any more. */
export const DEAD_ENDS = ["/milestones"] as const;

export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "Search", href: "/search" },
  { label: "Logbook", href: "/logbook" },
  { label: "Vault", href: "/vault" },
  { label: "Registry", href: "/registry" },
  { label: "Geld", href: "/money" },
  { label: "Tasks", href: "/tasks" },
  { label: "De zaak", href: "/timeline" },
  { label: "Review queue", href: "/queue" },
  { label: "Verify", href: "/verify" },
];
