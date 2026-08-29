"use client";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Button, Field, Input, Label, Notice, Panel } from "@/components/ui";

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
    <Panel className="p-[26px]">
      <div className="flex flex-col gap-[18px]">
        <div className="flex flex-col gap-[10px]">
          <Label as="h2">Wachtwoord wijzigen</Label>
          <p className="text-[13.5px] font-light leading-relaxed text-ink-mute">
            Het wachtwoord is je terugvaloptie als je geen passkey bij de hand hebt. Minstens
            12 tekens.
          </p>
        </div>

        <form className="flex max-w-sm flex-col gap-[14px]" onSubmit={submit}>
          {/*
            Visible labels, not placeholders. A placeholder disappears on the first
            keystroke, so a filled-in form shows two identical dot-rows with nothing
            saying which is which — and this form is reached most often by someone
            who has just been handed a new password, i.e. exactly the person who
            will read it as "new" + "confirm" and be told their password is wrong.
          */}
          <Field label="Huidig wachtwoord" htmlFor="current-password">
            <Input
              id="current-password" type="password"
              autoComplete="current-password" value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field
            label={<>Nieuw wachtwoord <span className="text-ink-dim">(minstens 12 tekens)</span></>}
            htmlFor="new-password"
          >
            <Input
              id="new-password" type="password"
              autoComplete="new-password" value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>
          {/* Ghost, not primary: the one glowing button on this screen adds a
              passkey. `Button` defaults to type="button", so a submit says so. */}
          <Button type="submit" disabled={busy} className="self-start">
            Wachtwoord wijzigen
          </Button>
        </form>

        {message && (
          <div role="status">
            <Notice tone="ok">{message}</Notice>
          </div>
        )}
        {error && (
          <div role="alert">
            <Notice tone="attn">{error}</Notice>
          </div>
        )}
      </div>
    </Panel>
  );
}
