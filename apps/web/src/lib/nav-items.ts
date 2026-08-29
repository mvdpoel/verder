/**
 * The sidebar, as data.
 *
 * It lives here rather than inline in `(app)/layout.tsx` so rules about it
 * can be asserted without rendering.
 */

export type NavItem = { label: string; href: string };

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
  { label: "Instellingen", href: "/settings/security" },
];
