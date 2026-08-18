/**
 * Safety guard for destructive test setup (TRUNCATE via the admin role).
 *
 * The insert-only grants protect the ledger from the app role, but not from
 * an admin connection. If DATABASE_URL ever points a test run at a non-local
 * database (e.g. the homelab deployment's real evidence ledger), refuse to
 * proceed instead of silently wiping it.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function assertSafeToTruncate(connectionUrl: string): void {
  let hostname: string;
  try {
    hostname = new URL(connectionUrl).hostname;
  } catch {
    throw new Error(
      `Refusing to truncate: could not parse database URL "${connectionUrl}".`,
    );
  }
  if (!LOCAL_HOSTS.has(hostname)) {
    throw new Error(
      `Refusing to truncate: database host "${hostname}" is not local. ` +
        "Destructive test setup only runs against localhost/127.0.0.1/::1 — " +
        "check DATABASE_URL before running these tests.",
    );
  }
}
