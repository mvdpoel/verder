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
      // One message for every failure sent Martin to re-check a password that
      // was fine: the real cause was that the form's two fields are
      // indistinguishable once filled (see the labels below). Name the cause.
      const code = "code" in res.error ? res.error.code : undefined;
      if (res.error.status === 429) {
        setError("Even wachten — te veel pogingen achter elkaar. Probeer het over een minuut opnieuw.");
      } else if (code === "INVALID_PASSWORD") {
        setError("Je huidige wachtwoord klopt niet. Let op: bovenin je HUIDIGE wachtwoord, onderin het nieuwe.");
      } else {
        setError("Dat lukte niet. Probeer het nog eens.");
      }
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
        {/*
          Visible labels, not placeholders. A placeholder disappears on the first
          keystroke, so a filled-in form shows two identical dot-rows with nothing
          saying which is which — and this form is reached most often by someone
          who has just been handed a new password, i.e. exactly the person who
          will read it as "new" + "confirm" and be told their password is wrong.
        */}
        <div>
          <label htmlFor="current-password" className="block text-sm font-medium text-slate-700 mb-1">
            Huidig wachtwoord
          </label>
          <input
            id="current-password"
            className="w-full border rounded p-2" type="password"
            autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="new-password" className="block text-sm font-medium text-slate-700 mb-1">
            Nieuw wachtwoord <span className="font-normal text-slate-500">(minstens 12 tekens)</span>
          </label>
          <input
            id="new-password"
            className="w-full border rounded p-2" type="password"
            autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)}
          />
        </div>
        <button disabled={busy} className="rounded bg-slate-900 text-white px-4 py-2 disabled:opacity-50">
          Wachtwoord wijzigen
        </button>
      </form>
      {message && <p className="text-green-700 text-sm">{message}</p>}
      {error && <p className="text-red-600 text-sm">{error}</p>}
    </section>
  );
}
