import { headers } from "next/headers";
import { count, eq } from "drizzle-orm";
import { schema } from "@verder/db";
import { getAuth } from "./auth";
import { getDb } from "./db";

/**
 * `GET /api/mobile/v1/me`: who the phone is signed in as, for Meer → Account.
 * The email and name come from the VALIDATED better-auth session, never from
 * the request; the passkey count is the same `passkey` table /settings/security
 * lists. Not evidence, writes nothing.
 */
export interface AccountDTO {
  email: string;
  /** Null when the account has no name; the phone draws only the email then. */
  name: string | null;
  /** Passkeys registered on the account (any device), so the phone can say "nog geen passkey". */
  passkeys: number;
}

interface SessionUser { id: string; email: string; name?: string | null }

export interface AccountDeps {
  getSession: () => Promise<{ user: SessionUser } | null>;
  countPasskeys: (userId: string) => Promise<number>;
}

export async function loadAccount(deps: AccountDeps = liveDeps()): Promise<AccountDTO | null> {
  const session = await deps.getSession();
  if (!session) return null;
  const { user } = session;
  const name = user.name?.trim() ? user.name.trim() : null;
  return { email: user.email, name, passkeys: await deps.countPasskeys(user.id) };
}

function liveDeps(): AccountDeps {
  return {
    getSession: async () => getAuth().api.getSession({ headers: await headers() }),
    countPasskeys: async (userId) => {
      const [row] = await getDb().db.select({ n: count() }).from(schema.passkey)
        .where(eq(schema.passkey.userId, userId));
      return Number(row?.n ?? 0);
    },
  };
}
