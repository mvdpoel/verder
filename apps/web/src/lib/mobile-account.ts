import { headers } from "next/headers";
import { and, count, eq, gt } from "drizzle-orm";
import { schema } from "@verder/db";
import { getAuth } from "./auth";
import { getDb } from "./db";

/**
 * `GET /api/mobile/v1/me`: who the phone is signed in as, for Meer → Account.
 * The email, name and session expiry come from the VALIDATED better-auth
 * session, never from the request; the passkey and device counts are the same
 * `passkey` and `session` tables /settings/security lists. Not evidence,
 * writes nothing.
 */
export interface AccountDTO {
  email: string;
  /** Null when the account has no name; the phone draws only the email then. */
  name: string | null;
  /** Passkeys registered on the account (any device), so the phone can say "nog geen toegangssleutel". */
  passkeys: number;
  /** When THIS session ends: "sessie tot 1 dec" on the phone. */
  sessionExpiresAt: Date;
  /** Live sessions on the account (every iPhone and browser signed in): "3 ingelogd". */
  devices: number;
}

interface SessionUser { id: string; email: string; name?: string | null }

export interface AccountDeps {
  getSession: () => Promise<{ user: SessionUser; session: { expiresAt: Date } } | null>;
  countPasskeys: (userId: string) => Promise<number>;
  /** Sessions of the user that have not expired at `now` — what /settings/security lists. */
  countSessions: (userId: string, now: Date) => Promise<number>;
  now?: () => Date;
}

export async function loadAccount(deps: AccountDeps = liveDeps()): Promise<AccountDTO | null> {
  const session = await deps.getSession();
  if (!session) return null;
  const { user } = session;
  const name = user.name?.trim() ? user.name.trim() : null;
  const now = (deps.now ?? (() => new Date()))();
  return {
    email: user.email, name, passkeys: await deps.countPasskeys(user.id),
    sessionExpiresAt: session.session.expiresAt,
    devices: await deps.countSessions(user.id, now),
  };
}

function liveDeps(): AccountDeps {
  return {
    getSession: async () => getAuth().api.getSession({ headers: await headers() }),
    countPasskeys: async (userId) => {
      const [row] = await getDb().db.select({ n: count() }).from(schema.passkey)
        .where(eq(schema.passkey.userId, userId));
      return Number(row?.n ?? 0);
    },
    countSessions: async (userId, now) => {
      const [row] = await getDb().db.select({ n: count() }).from(schema.session)
        .where(and(eq(schema.session.userId, userId), gt(schema.session.expiresAt, now)));
      return Number(row?.n ?? 0);
    },
  };
}
