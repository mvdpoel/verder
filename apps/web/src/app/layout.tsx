import "./globals.css";
import Link from "next/link";
import { TRPCProvider } from "@/lib/trpc-client";

export const metadata = { title: "verder — jouw dossier, jouw bewijs" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900">
        <TRPCProvider>
          <div className="flex">
            <nav className="w-56 min-h-screen border-r bg-white p-4 space-y-2">
              <p className="font-bold text-lg mb-4">verder</p>
              {[["Dashboard", "/dashboard"], ["Logbook", "/logbook"], ["Vault", "/vault"],
                ["Review queue", "/queue"], ["Verify", "/verify"]].map(([label, href]) => (
                <Link key={href} href={href} className="block rounded px-3 py-2 hover:bg-slate-100">{label}</Link>
              ))}
            </nav>
            <main className="flex-1 p-8">{children}</main>
          </div>
        </TRPCProvider>
      </body>
    </html>
  );
}
