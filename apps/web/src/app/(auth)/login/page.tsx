"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { TRUST_HEADER } from "@verder/auth/session-trust";
import { authClient } from "@/lib/auth-client";
import { Button, Checkbox, cx, Field, Input, Notice, Panel } from "@/components/ui";

/**
 * The front door. It sits in the `(auth)` group, OUTSIDE the app shell, so it
 * gets no rail, no top bar and no field — and therefore paints its own: the
 * same `field-aura` + `field-grid` layers the shell uses, with one lit panel
 * centred on top. This is the only screen in the app that is allowed a little
 * ceremony, because it is the only one someone meets before they are anybody.
 */
export default function LoginPage() {
  const router = useRouter();
  const [trust, setTrust] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The whole trust mechanism, from the browser's side: one header on the
  // request that creates the session. The server decides what it means.
  const trustHeaders = () => (trust ? { [TRUST_HEADER]: "1" } : {});

  async function signInWithPasskey() {
    setError(null);
    setBusy(true);
    const res = await authClient.signIn.passkey({
      fetchOptions: { headers: trustHeaders() },
    });
    setBusy(false);
    // Dismissing the Touch ID sheet is a decision, not a failure. Saying
    // "that didn't work" to someone who simply changed their mind is noise.
    // `code` is present on only one arm of better-auth's error union, so it is
    // narrowed with `in` rather than read straight off `res.error`.
    if (res?.error && "code" in res.error && res.error.code === "AUTH_CANCELLED") return;
    if (res?.error) {
      setError("Die passkey werd niet herkend. Probeer het opnieuw, of gebruik je wachtwoord.");
      return;
    }
    router.push("/dashboard");
  }

  async function signInWithPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const res = await authClient.signIn.email(
      { email, password },
      { headers: trustHeaders() },
    );
    setBusy(false);
    if (res.error) {
      setError("Dat werkte niet — controleer je e-mailadres en wachtwoord en probeer het nog eens.");
      return;
    }
    router.push("/dashboard");
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center p-6">
      <div className="field-aura" />
      <div className="field-grid" />

      <div className="relative w-full max-w-[390px]">
        <div className="mb-[26px] flex flex-col items-center gap-[13px]">
          {/* The rail's mark, the one thing that says which system this is. */}
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
              Welkom terug 👋
            </h1>

            <div className="flex flex-col gap-[13px]">
              {/* The passkey is the way in; the password below is the fallback,
                  so the glow belongs here and nowhere else on this screen. */}
              <Button
                variant="primary"
                disabled={busy}
                onClick={signInWithPasskey}
                className="w-full">
                Inloggen met passkey
              </Button>

              <Checkbox
                id="trust-device"
                aria-describedby="trust-device-hint"
                checked={trust}
                onChange={(e) => setTrust(e.target.checked)}
                label="Vertrouw dit apparaat 30 dagen"
              />
              {/*
                The explanation used to sit inside the label. Out here it stays
                readable as a hint instead of a two-line checkbox caption, and
                `aria-describedby` keeps it attached to the control for anyone
                who cannot see the layout.
              */}
              <p
                id="trust-device-hint"
                className="text-xs font-light leading-relaxed text-ink-label">
                Anders blijf je 12 uur ingelogd. Kies dit niet op een apparaat dat niet van jou is.
              </p>
            </div>

            {/* A sign-in that failed is literally waiting on Martin, which is
                the one thing amber is allowed to mean. */}
            {error && (
              <div role="alert">
                <Notice tone="attn">{error}</Notice>
              </div>
            )}

            <div className="flex flex-col gap-4 border-t border-hairline pt-[18px]">
              <Button
                variant="quiet"
                size="sm"
                className="self-start px-0"
                aria-expanded={showPassword}
                onClick={() => setShowPassword((v) => !v)}
              >
                Andere manieren om in te loggen
              </Button>

              {showPassword && (
                <form className="flex flex-col gap-[14px]" onSubmit={signInWithPassword}>
                  <Field label="E-mailadres" htmlFor="login-email">
                    <Input
                      id="login-email" type="email"
                      autoComplete="username" value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </Field>
                  <Field label="Wachtwoord" htmlFor="login-password">
                    <Input
                      id="login-password" type="password"
                      autoComplete="current-password" value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </Field>
                  {/* `Button` defaults to type="button"; a form's submit must say so. */}
                  <Button type="submit" disabled={busy} className="w-full">
                    Inloggen met wachtwoord
                  </Button>
                </form>
              )}
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
