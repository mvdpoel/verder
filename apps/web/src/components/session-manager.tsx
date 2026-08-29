"use client";
import { useCallback, useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Button, Label, Micro, Notice, Panel, Row } from "@/components/ui";

type SessionRow = {
  id: string;
  token: string;
  createdAt: string | Date;
  expiresAt: string | Date;
  ipAddress?: string | null;
  userAgent?: string | null;
};

/**
 * There is no device table. better-auth already stores userAgent and
 * ipAddress on every session row, so a session IS a device for this purpose
 * and revoking one is exactly what "this device is no longer trusted" means.
 */
export function SessionManager() {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await authClient.listSessions();
    if (res.error) { setError("De apparatenlijst kon niet worden geladen."); return; }
    setSessions(res.data as SessionRow[]);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function revoke(token: string) {
    const res = await authClient.revokeSession({ token });
    if (res.error) { setError("Intrekken lukte niet. Probeer het nog eens."); return; }
    void load();
  }

  return (
    <Panel className="p-[26px]">
      <div className="flex flex-col gap-[18px]">
        <div className="flex flex-col gap-[10px]">
          <Label as="h2">Je apparaten</Label>
          <p className="text-[13.5px] font-light leading-relaxed text-ink-mute">
            Elk apparaat waarop je bent ingelogd. Herken je er een niet? Trek hem in — daarna
            is een passkey of je wachtwoord weer nodig.
          </p>
        </div>

        {sessions === null && <Micro>Laden…</Micro>}

        {/* No empty state: this page is being read FROM a session, so the list
            is never empty, and inventing copy for a state that cannot happen
            is worse than leaving the gap. */}
        {sessions !== null && sessions.length > 0 && (
          <ul className="flex flex-col">
            {sessions.map((s) => (
              /*
                A live session is a cyan ring, not a filled steel dot: it is
                still running rather than something that happened. Amber would
                claim the device is waiting on Martin, which it is not.
              */
              <Row
                as="li"
                key={s.id}
                state="open"
                title={describeAgent(s.userAgent)}
                kicker={`${s.ipAddress || "onbekend IP"} · verloopt ${new Date(s.expiresAt).toLocaleString("nl-NL")}`}
                meta={
                  <Button variant="danger" size="sm" onClick={() => revoke(s.token)}>
                    Intrekken
                  </Button>
                }
              />
            ))}
          </ul>
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

/** A raw user-agent string is unreadable; this is a label, not a parser. */
function describeAgent(ua: string | null | undefined): string {
  if (!ua) return "Onbekend apparaat";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android-toestel";
  if (/Macintosh/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows-pc";
  if (/Linux/i.test(ua)) return "Linux-machine";
  return "Onbekend apparaat";
}
