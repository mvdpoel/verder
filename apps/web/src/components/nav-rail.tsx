"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NavIcon } from "@/components/nav-icons";
import { activeNavHref, NAV_ITEMS } from "@/lib/nav-items";
import { cx } from "@/components/ui";

/**
 * The rail, and the one thing it was missing: where you are.
 *
 * The rail is icons without labels, which is affordable only because it also
 * says which of the eleven you are looking at — an unlabelled icon set with no
 * position marker is not a map, it is eleven identical buttons. `aria-current`
 * carries the same fact to a screen reader, which never sees the colour.
 *
 * NO GLOW on the active mark, deliberately: in this system a glow means
 * "you can press this and something will happen" (globals.css, rule 2), and
 * where you already are is a statement, not an action. It gets the system's
 * cyan, a quiet plate behind it and a bar on the rail edge — the same bar the
 * panels use to mark their lit edge.
 *
 * A client component purely for `usePathname`; the shell around it stays a
 * server component and keeps rendering the rail's contents from `NAV_ITEMS`.
 */
export function NavRail() {
  const pathname = usePathname();
  const active = activeNavHref(pathname);

  return (
    <nav
      aria-label="Hoofdnavigatie"
      className="flex w-[78px] shrink-0 flex-col items-center gap-1.5 border-r border-edge bg-rail py-[26px]">
      <Link href="/dashboard" aria-label="verder" className="mb-[22px] text-signal">
        <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
          <circle cx="13" cy="13" r="11" stroke="currentColor" strokeWidth="1" />
          <path d="M13 3.2 L13 22.8" stroke="currentColor" strokeWidth="1" opacity="0.45" />
          <path d="M5.4 8.4 C 10 13, 16 13, 20.6 8.4" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </Link>

      {NAV_ITEMS.map(({ label, href }) => {
        const isActive = href === active;
        return (
          <Link
            key={href}
            href={href}
            title={label}
            aria-label={label}
            aria-current={isActive ? "page" : undefined}
            className={cx(
              "relative flex h-[44px] w-[46px] items-center justify-center rounded-panel transition-colors",
              isActive
                ? "bg-signal/12 text-signal"
                : "text-ink-dim hover:bg-signal/10 hover:text-signal",
            )}>
            {isActive && (
              // On the rail's own border, so the mark reads as the rail
              // pointing at the page rather than as a decoration on the icon.
              <span
                aria-hidden="true"
                className="absolute -right-px top-1/2 h-[22px] w-px -translate-y-1/2 bg-signal"
              />
            )}
            <NavIcon href={href} />
          </Link>
        );
      })}
    </nav>
  );
}
