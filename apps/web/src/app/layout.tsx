import "./globals.css";
import { TRPCProvider } from "@/lib/trpc-client";

export const metadata = { title: "verder — jouw dossier, jouw bewijs" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900">
        <TRPCProvider>{children}</TRPCProvider>
      </body>
    </html>
  );
}
