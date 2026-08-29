import "./globals.css";
import { IBM_Plex_Mono, Saira } from "next/font/google";
import { TRPCProvider } from "@/lib/trpc-client";

/**
 * The system's two faces, self-hosted.
 *
 * `next/font` fetches them at BUILD time and serves them from our own origin
 * afterwards, so the running app never talks to Google — which, for a dossier
 * with debt papers in it, is the difference between "we use a typeface" and
 * "every page Martin opens announces itself to a third party".
 */
const saira = Saira({
  subsets: ["latin"],
  weight: ["200", "300", "400", "500"],
  variable: "--font-saira",
  display: "swap",
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata = { title: "verder — jouw dossier, jouw bewijs" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="nl" className={`${saira.variable} ${plexMono.variable}`}>
      <body className="min-h-screen bg-void text-ink">
        <TRPCProvider>{children}</TRPCProvider>
      </body>
    </html>
  );
}
