// The explicit React import is what makes this file testable: apps/web sets
// `jsx: "preserve"` for Next, so vitest's esbuild falls back to the CLASSIC
// JSX transform and emits React.createElement calls. Next itself is unaffected.
import React from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CommandPalette } from "@/components/command-palette";
import { NAV_ITEMS } from "@/lib/nav-items";
import { getSessionUserId } from "@/lib/trpc-server";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // middleware.ts only checks that a session cookie EXISTS. An untrusted
  // session's cookie outlives its database row by design (the cookie carries
  // the 30-day max-age; the row expires after 12 hours), so without this the
  // middleware would wave a dead session through to a page that cannot load
  // anything. Every data path already revalidates; this is what stops the
  // user meeting a broken page instead of the login screen.
  if (!(await getSessionUserId())) redirect("/login");

  return (
    <div className="flex">
      <nav className="w-56 min-h-screen border-r bg-white p-4 space-y-2">
        <p className="font-bold text-lg mb-4">verder</p>
        {NAV_ITEMS.map(({ label, href }) => (
          <Link key={href} href={href} className="block rounded px-3 py-2 hover:bg-slate-100">{label}</Link>
        ))}
      </nav>
      <main className="flex-1 p-8">{children}</main>
      <CommandPalette />
    </div>
  );
}
