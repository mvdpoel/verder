"use client";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Button, Empty, Field, Input, Label, Micro, Notice, Panel, Row } from "@/components/ui";

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

  const empty = !isPending && (passkeys?.length ?? 0) === 0;

  return (
    <Panel lit className="p-[26px]">
      <div className="flex flex-col gap-[18px]">
        <div className="flex flex-col gap-[10px]">
          <Label as="h2">Je passkeys</Label>
          <p className="text-[13.5px] font-light leading-relaxed text-ink-mute">
            Een passkey is de vingerafdruk of Face ID van dit apparaat. Er valt niets te
            onthouden en niets te verliezen aan een phishingmail.
          </p>
        </div>

        {isPending && <Micro>Laden…</Micro>}

        {empty && <Empty title="Nog geen passkeys. Voeg er hieronder een toe." />}

        {!empty && (
          // `Row as="li"`: the rows are the list's own children, so the hairline
          // it draws under all but the last one lands where it is meant to.
          <ul className="flex flex-col">
            {passkeys?.map((pk) => (
              <Row
                as="li"
                key={pk.id}
                state="done"
                title={pk.name ?? "Naamloos apparaat"}
                kicker={`toegevoegd ${pk.createdAt ? new Date(pk.createdAt).toLocaleDateString("nl-NL") : "—"}`}
                meta={
                  <Button variant="danger" size="sm" onClick={() => remove(pk.id)}>
                    Verwijderen
                  </Button>
                }
              />
            ))}
          </ul>
        )}

        <div className="flex flex-col gap-[10px] sm:flex-row sm:items-end">
          {/* The placeholder became the label: a placeholder disappears on the
              first keystroke, and then the field has no name on it. */}
          <Field className="grow" label="Naam, bijv. MacBook of iPhone" htmlFor="passkey-name">
            <Input id="passkey-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Button variant="primary" onClick={add} disabled={busy}>
            Passkey toevoegen
          </Button>
        </div>

        {error && (
          <div role="alert">
            <Notice tone="attn">{error}</Notice>
          </div>
        )}
      </div>
    </Panel>
  );
}
