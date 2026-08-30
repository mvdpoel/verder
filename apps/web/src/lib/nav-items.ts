/**
 * The sidebar, as data.
 *
 * It lives here rather than inline in `(app)/layout.tsx` so rules about it
 * can be asserted without rendering.
 */

export type NavItem = { label: string; href: string };

/**
 * IN DUTCH, all eleven. The rail was seven English labels next to four Dutch
 * ones — "Vault, Registry, Verify" beside "Geld, De zaak, Instellingen" — which
 * is the app asking its reader to hold two vocabularies for one dossier. These
 * are the `title` and `aria-label` on an icon that has no visible word beside
 * it, so they are also the ONLY name most of these destinations ever get.
 */
export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "Zoeken", href: "/search" },
  { label: "Logboek", href: "/logbook" },
  { label: "Kluis", href: "/vault" },
  // "Register" and not "Registratie": this is the ledger of contracts and
  // debts, not the act of registering something.
  { label: "Register", href: "/registry" },
  { label: "Geld", href: "/money" },
  { label: "Taken", href: "/tasks" },
  { label: "De zaak", href: "/timeline" },
  { label: "Te beoordelen", href: "/queue" },
  { label: "Controle", href: "/verify" },
  { label: "Instellingen", href: "/settings/security" },
];

/**
 * Which rail entry the current path belongs to, or null for a page that is on
 * no destination in the rail.
 *
 * PREFIX MATCHING, not equality: `/logbook/abc` and `/logbook/new` are both
 * "Logbook" to a reader, and a rail that goes dark the moment you open a detail
 * page is worse than no marker at all. The boundary is a SLASH — plain
 * `startsWith` would light `/tasks` for a future `/tasks-archive`.
 *
 * The LONGEST match wins, so a nested destination added later (`/registry` and
 * a hypothetical `/registry/debts`) marks the more specific of the two rather
 * than whichever happens to sit first in the list.
 */
export function activeNavHref(pathname: string, items: readonly NavItem[] = NAV_ITEMS): string | null {
  let best: string | null = null;
  for (const { href } of items) {
    if (pathname === href || pathname.startsWith(`${href}/`)) {
      if (best === null || href.length > best.length) best = href;
    }
  }
  return best;
}
