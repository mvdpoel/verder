import Link from "next/link";
import { CommandPalette } from "@/components/command-palette";
import { NAV_ITEMS } from "@/lib/nav-items";

export default function AppLayout({ children }: { children: React.ReactNode }) {
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
