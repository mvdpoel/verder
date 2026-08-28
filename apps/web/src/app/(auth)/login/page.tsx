"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { TRUST_HEADER } from "@verder/auth/session-trust";
import { authClient } from "@/lib/auth-client";

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
    <div className="max-w-sm mx-auto mt-24 space-y-6">
      <h1 className="text-2xl font-bold">Welkom terug 👋</h1>

      <button
        type="button"
        disabled={busy}
        onClick={signInWithPasskey}
        className="w-full rounded bg-slate-900 text-white p-3 disabled:opacity-50"
      >
        Inloggen met passkey
      </button>

      <label className="flex items-start gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          className="mt-1"
          checked={trust}
          onChange={(e) => setTrust(e.target.checked)}
        />
        <span>
          Vertrouw dit apparaat 30 dagen
          <span className="block text-slate-500">
            Anders blijf je 12 uur ingelogd. Kies dit niet op een apparaat dat niet van jou is.
          </span>
        </span>
      </label>

      {error && <p className="text-red-600 text-sm">{error}</p>}

      <div className="border-t pt-4">
        <button
          type="button"
          onClick={() => setShowPassword((v) => !v)}
          className="text-sm text-slate-600 underline"
        >
          Andere manieren om in te loggen
        </button>

        {showPassword && (
          <form className="mt-4 space-y-3" onSubmit={signInWithPassword}>
            <input
              className="w-full border rounded p-2" type="email" placeholder="E-mailadres"
              autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)}
            />
            <input
              className="w-full border rounded p-2" type="password" placeholder="Wachtwoord"
              autoComplete="current-password" value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button disabled={busy} className="w-full rounded border p-2 disabled:opacity-50">
              Inloggen met wachtwoord
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
