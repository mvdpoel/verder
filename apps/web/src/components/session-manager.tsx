"use client";
import { useCallback, useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";

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
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Je apparaten</h2>
      <p className="text-sm text-slate-600">
        Elk apparaat waarop je bent ingelogd. Herken je er een niet? Trek hem in — daarna
        is een passkey of je wachtwoord weer nodig.
      </p>

      {sessions === null && <p className="text-sm text-slate-500">Laden…</p>}

      <ul className="divide-y border rounded">
        {sessions?.map((s) => (
          <li key={s.id} className="flex items-center justify-between p-3">
            <span>
              <span className="font-medium">{describeAgent(s.userAgent)}</span>
              <span className="block text-xs text-slate-500">
                {s.ipAddress || "onbekend IP"} · verloopt{" "}
                {new Date(s.expiresAt).toLocaleString("nl-NL")}
              </span>
            </span>
            <button onClick={() => revoke(s.token)} className="text-sm text-red-600 underline">
              Intrekken
            </button>
          </li>
        ))}
      </ul>

      {error && <p className="text-red-600 text-sm">{error}</p>}
    </section>
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
