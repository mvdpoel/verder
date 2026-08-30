// `React` is here for the TYPE `React.ReactNode` in the props below; the JSX
// transform no longer needs it. Vitest used to run the classic transform
// (apps/web sets `jsx: "preserve"` for Next) and needed the import in every
// .tsx file — `vitest.config.ts` now sets `jsx: "automatic"`, which takes that
// trap out for the whole app.
import React from "react";
import { redirect } from "next/navigation";
import { CommandPalette } from "@/components/command-palette";
import { NavRail } from "@/components/nav-rail";
import { PaletteTrigger } from "@/components/palette-trigger";
import { getSessionUserId } from "@/lib/trpc-server";

/**
 * The shell: icon rail on the left, measurement bar on top, the field behind it.
 *
 * THE RAIL IS ICONS WITHOUT LABELS, and that choice has a price: eleven
 * destinations with no word beside them has to be learnt. What makes the price
 * bearable is that there are eleven of them and not fifty, that every icon
 * carries its name as `title` and `aria-label`, that the rail marks WHICH of
 * the eleven you are on (`NavRail`, without which it is not a map at all), and
 * that ⌘K cuts straight through — the rail is the map, the palette is the
 * motorway.
 *
 * THE FIELD (`field-aura` and `field-grid`) is pure atmosphere. It sits on a
 * layer with no pointer events and carries no fact at all; whoever turned motion
 * off gets it still, and the page then works exactly the same.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // middleware.ts only checks that a session cookie EXISTS. An untrusted
  // session's cookie outlives its database row by design (the cookie carries
  // the 30-day max-age; the row expires after 12 hours), so without this the
  // middleware would wave a dead session through to a page that cannot load
  // anything. Every data path already revalidates; this is what stops the
  // user meeting a broken page instead of the login screen.
  if (!(await getSessionUserId())) redirect("/login");

  return (
    <div className="relative min-h-screen">
      <div className="field-aura" />
      <div className="field-grid" />

      <div className="relative flex min-h-screen">
        <NavRail />

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-[62px] shrink-0 items-center gap-7 border-b border-hairline-lit px-10">
            <div className="text-[15px] tracking-[0.44em] text-ink-soft">VERDER</div>
            <div className="hidden font-mono text-[10.5px] tracking-[0.16em] text-ink-dim lg:block">
              DOSSIER NLTZ2612548IVB · ONDER BEWIND · VERDERGROEP
            </div>
            <div className="ml-auto flex items-center gap-[18px]">
              <PaletteTrigger />
            </div>
          </header>

          {/*
            `min-w-0` is what keeps the wide children (the map on /timeline, the
            table on /registry/[id]) inside their own scroll area instead of
            making the whole page slide sideways — sidebar and all.
          */}
          <main className="min-w-0 flex-1 p-10">{children}</main>
        </div>
      </div>

      <CommandPalette />
    </div>
  );
}
