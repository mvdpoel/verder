"use client";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

/**
 * Passkeys are named by hand because nothing can name them automatically:
 * Apple zeroes the AAGUID under the default attestation flow, so the
 * plugin's authenticator lookup table resolves nothing for a MacBook or an
 * iPhone. An unnamed list of three credentials is a list you cannot revoke
 * safely from.
 */
export function PasskeyManager() {
  const { data: passkeys, isPending, refetch } = authClient.useListPasskeys();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add() {
    setError(null);
    setBusy(true);
    const res = await authClient.passkey.addPasskey({ name: name.trim() || "Naamloos apparaat" });
    setBusy(false);
    // The error union has a `code` only on one of its two arms, so it has to
    // be narrowed before it is read. A cancelled Touch ID prompt is not a
    // failure and must not paint a red message.
    if (res?.error && "code" in res.error && res.error.code === "AUTH_CANCELLED") return;
    if (res?.error) {
      setError("Die passkey kon niet worden toegevoegd. Probeer het nog eens.");
      return;
    }
    setName("");
    refetch();
  }

  async function remove(id: string) {
    setError(null);
    // The plugin exposes this endpoint through server-plugin inference. If the
    // typed method is ever missing, the equivalent call is:
    //   authClient.$fetch("/passkey/delete-passkey", { method: "POST", body: { id } })
    const res = await authClient.passkey.deletePasskey({ id });
    if (res?.error) {
      setError("Verwijderen lukte niet. Probeer het nog eens.");
      return;
    }
    refetch();
  }

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Je passkeys</h2>
      <p className="text-sm text-slate-600">
        Een passkey is de vingerafdruk of Face ID van dit apparaat. Er valt niets te
        onthouden en niets te verliezen aan een phishingmail.
      </p>

      {isPending && <p className="text-sm text-slate-500">Laden…</p>}

      {!isPending && (passkeys?.length ?? 0) === 0 && (
        <p className="text-sm text-slate-500">Nog geen passkeys. Voeg er hieronder een toe.</p>
      )}

      <ul className="divide-y border rounded">
        {passkeys?.map((pk) => (
          <li key={pk.id} className="flex items-center justify-between p-3">
            <span>
              <span className="font-medium">{pk.name ?? "Naamloos apparaat"}</span>
              <span className="block text-xs text-slate-500">
                toegevoegd {pk.createdAt ? new Date(pk.createdAt).toLocaleDateString("nl-NL") : "—"}
              </span>
            </span>
            <button onClick={() => remove(pk.id)} className="text-sm text-red-600 underline">
              Verwijderen
            </button>
          </li>
        ))}
      </ul>

      <div className="flex gap-2">
        <input
          className="flex-1 border rounded p-2" placeholder="Naam, bijv. MacBook of iPhone"
          value={name} onChange={(e) => setName(e.target.value)}
        />
        <button
          onClick={add} disabled={busy}
          className="rounded bg-slate-900 text-white px-4 disabled:opacity-50"
        >
          Passkey toevoegen
        </button>
      </div>

      {error && <p className="text-red-600 text-sm">{error}</p>}
    </section>
  );
}
