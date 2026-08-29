import type { ReactNode } from "react";

/**
 * The sidebar's icons, one per destination.
 *
 * All hand-drawn on one 24 grid, one stroke width, round caps — no emoji and no
 * icon package: a package brings a second drawing style that never quite talks
 * its way into this system, and it would be the web app's first runtime
 * dependency beside Next and React.
 *
 * The key is the `href` from `NAV_ITEMS`, so a new destination with no drawing
 * here yet simply gets the dot instead of disappearing.
 */
export const NAV_ICON: Record<string, ReactNode> = {
  "/dashboard": (
    <>
      <rect x="3" y="3" width="7.5" height="7.5" />
      <rect x="13.5" y="3" width="7.5" height="7.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" />
    </>
  ),
  "/search": (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5 L21 21" />
    </>
  ),
  "/logbook": (
    <>
      <path d="M5 4h11l3.5 3.5V20H5z" />
      <path d="M8 10h8M8 14h5" />
    </>
  ),
  "/vault": (
    <>
      <rect x="3.5" y="6" width="17" height="13" />
      <path d="M3.5 10h17M9 6V4.5h6V6" />
    </>
  ),
  "/registry": (
    <>
      <path d="M4.5 6.5h15v13h-15z" />
      <path d="M8 10.5h8M8 14.5h5" />
    </>
  ),
  "/money": <path d="M4 19V9M10 19V5M16 19v-6M22 19H2" />,
  "/tasks": (
    <>
      <path d="M4 7.5l2.2 2.2L10.5 5" />
      <path d="M4 16.5l2.2 2.2L10.5 14" />
      <path d="M13.5 8.5h7M13.5 17.5h7" />
    </>
  ),
  "/timeline": (
    <>
      <circle cx="7" cy="7" r="2.6" />
      <circle cx="17" cy="17" r="2.6" />
      <path d="M7 9.6V21M17 14.4V3M7 15h10" />
    </>
  ),
  "/queue": (
    <>
      <path d="M4.5 7h15M4.5 12h15M4.5 17h9" />
    </>
  ),
  "/verify": (
    <>
      <path d="M12 3.5 20 7v6.5c0 4-3.4 6.4-8 7.5-4.6-1.1-8-3.5-8-7.5V7z" />
      <path d="M9 12l2.2 2.2L15.5 10" />
    </>
  ),
  "/settings/security": (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8" />
    </>
  ),
};

export function NavIcon({ href }: { href: string }) {
  const drawing = NAV_ICON[href];
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {drawing ?? <circle cx="12" cy="12" r="4" />}
    </svg>
  );
}
