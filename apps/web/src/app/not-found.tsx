import Link from "next/link";
import { buttonClass, Panel } from "@/components/ui";

/**
 * A URL that matches no route at all.
 *
 * Next resolves an unmatched path against the ROOT boundary — it cannot know
 * the visitor meant to be inside the app — so this one renders without the rail
 * and paints its own field, the way `/login` does. The `(app)` group has its own
 * `not-found.tsx` for the commoner case: a route that exists, holding a record
 * that does not.
 */
export default function RootNotFound() {
  return (
    <div className="relative flex min-h-screen items-center justify-center p-6">
      <div className="field-aura" />
      <div className="field-grid" />
      <div className="relative w-full max-w-[420px]">
        <div className="mb-[26px] flex flex-col items-center gap-[13px]">
          <svg width="34" height="34" viewBox="0 0 26 26" fill="none" className="text-signal" aria-hidden="true">
            <circle cx="13" cy="13" r="11" stroke="currentColor" strokeWidth="1" />
            <path d="M13 3.2 L13 22.8" stroke="currentColor" strokeWidth="1" opacity="0.45" />
            <path d="M5.4 8.4 C 10 13, 16 13, 20.6 8.4" stroke="currentColor" strokeWidth="1.2" />
          </svg>
          <div className="text-[15px] tracking-[0.44em] text-ink-soft">VERDER</div>
        </div>
        <Panel lit>
          <div className="flex flex-col gap-[22px] p-[30px]">
            <h1 className="text-[26px] font-extralight tracking-[-0.015em] text-ink-bright">
              Deze pagina bestaat niet
            </h1>
            <p className="text-[13.5px] font-light leading-relaxed text-ink-mute">
              Het adres klopt niet. Ga terug naar het dashboard — daar staat waar
              het dossier op dit moment staat.
            </p>
            <Link className={buttonClass("primary")} href="/dashboard">
              Naar het dashboard
            </Link>
          </div>
        </Panel>
      </div>
    </div>
  );
}
