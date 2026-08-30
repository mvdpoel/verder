"use client";

/**
 * The last boundary: the ROOT layout itself failed.
 *
 * This one replaces the whole document, `<html>` and `<body>` included, so the
 * root layout never ran — which means no globals.css, no design tokens and no
 * self-hosted fonts. EVERY STYLE HERE IS THEREFORE INLINE, and deliberately so:
 * a page that renders only when the stylesheet is gone cannot depend on the
 * stylesheet. The colours are literal copies of `--color-void`, `--color-ink`
 * and `--color-signal` rather than tokens, for the same reason the two print
 * exports spell their paper palette out by hand.
 *
 * In practice almost nothing reaches this — `(app)/error.tsx` catches page
 * failures with the shell intact. This is what stands between a broken root
 * layout and a white screen with no words on it.
 */
export default function GlobalError({
  error, reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="nl">
      <body style={{
        margin: 0, minHeight: "100vh", display: "flex", alignItems: "center",
        justifyContent: "center", padding: 24, background: "#04070d", color: "#dbe6f2",
        fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
      }}>
        <main style={{ maxWidth: 460 }}>
          <h1 style={{ fontSize: 26, fontWeight: 200, color: "#f0f7fc", margin: "0 0 14px" }}>
            Verder kon niet opstarten
          </h1>
          <p style={{ fontSize: 14, lineHeight: 1.7, color: "#93a8bd", margin: "0 0 22px" }}>
            Er is niets kwijt en er is niets veranderd — het dossier staat er nog
            precies zo bij. Probeer het opnieuw; blijft dit staan, dan moet de
            server een herstart hebben.
          </p>
          <button
            onClick={reset}
            style={{
              font: "inherit", fontSize: 14, cursor: "pointer", padding: "10px 18px",
              borderRadius: 8, border: "1px solid #63d3ea", background: "transparent",
              color: "#63d3ea",
            }}>
            Opnieuw proberen
          </button>
          {error.digest && (
            <p style={{
              marginTop: 22, fontSize: 11, letterSpacing: "0.12em", color: "#63788e",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", wordBreak: "break-all",
            }}>
              foutcode {error.digest}
            </p>
          )}
        </main>
      </body>
    </html>
  );
}
