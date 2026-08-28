"use client";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

/**
 * The seed script skips a user that already exists, so without this form the
 * only way to move to a longer password is a shell on the homelab.
 */
export function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    if (next.length < 12) {
      setError("Kies een wachtwoord van minstens 12 tekens.");
      return;
    }
    setBusy(true);
    const res = await authClient.changePassword({
      currentPassword: current,
      newPassword: next,
      // Keep this session; every other one has to sign in again. A password
      // change is exactly when a forgotten device should stop working.
      revokeOtherSessions: true,
    });
    setBusy(false);
    if (res.error) {
      setError("Dat lukte niet — klopt je huidige wachtwoord?");
      return;
    }
    setCurrent("");
    setNext("");
    setMessage("Gelukt. Je andere apparaten moeten opnieuw inloggen.");
  }

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Wachtwoord wijzigen</h2>
      <p className="text-sm text-slate-600">
        Het wachtwoord is je terugvaloptie als je geen passkey bij de hand hebt. Minstens
        12 tekens.
      </p>
      <form className="space-y-3 max-w-sm" onSubmit={submit}>
        <input
          className="w-full border rounded p-2" type="password" placeholder="Huidig wachtwoord"
          autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)}
        />
        <input
          className="w-full border rounded p-2" type="password" placeholder="Nieuw wachtwoord"
          autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)}
        />
        <button disabled={busy} className="rounded bg-slate-900 text-white px-4 py-2 disabled:opacity-50">
          Wachtwoord wijzigen
        </button>
      </form>
      {message && <p className="text-green-700 text-sm">{message}</p>}
      {error && <p className="text-red-600 text-sm">{error}</p>}
    </section>
  );
}
