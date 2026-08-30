import { basic, call, download, openSession } from "./jmap-client";
import { makeJmapPort, type JmapPortLimits, type MailDateFallback } from "./jmap-port";
import type { MailPort } from "./port";

/**
 * The ONE place a live MailPort is built from the environment.
 *
 * It exists as its own module because there is more than one entry point that
 * needs a port — the worker's `index.ts` and any `ops/` script that has to poll
 * or backfill by hand — and each of them spelling out "read the vars, strip the
 * slash, build the credential, open the session, wire call and download" is how
 * two of them end up authenticating differently. The failure is not loud: the
 * spelling that was TESTED keeps working, and the other one gets a 401 that
 * reads like a wrong app password, or silently talks to `//.well-known/jmap`.
 * One factory means the wiring test below covers every caller.
 *
 * NOTHING else in `mail/` reads an env var for the connection: jmap-client says
 * so in as many words ("this module takes a credential, it never sources one"),
 * and jmap-port takes a session and a credential. This is the seam where
 * configuration becomes a dependency, and it is the only one.
 */

/** Configuration that cannot produce a connection, named so an operator can fix
 *  it in one pass. It carries NO value — this message reaches worker_runs.detail
 *  like every other throw on the mail path, which the dashboard renders and the
 *  nightly dump writes off-box, and an app password does not expire. */
export class MailEnvError extends Error {
  constructor(readonly missing: string[]) {
    super(`mail is not configured: ${missing.join(", ")} `
      + `${missing.length === 1 ? "is" : "are"} missing or empty`);
    this.name = "MailEnvError";
  }
}

/**
 * There is no JMAP_TOKEN. It is RETIRED, not deprecated, and deliberately not
 * read as a fallback: a bearer token and an app password authenticate against
 * different things in Stalwart, and a fallback would let a stale token in
 * .env.prod keep a deployment working right up until the hour it expires — the
 * exact silent-death-on-day-91 that got OAuth rejected in the first place.
 */
const REQUIRED = ["JMAP_BASE_URL", "JMAP_USER", "JMAP_APP_PASSWORD"] as const;

export interface MailEnv { baseUrl: string; user: string; appPassword: string }

export function mailEnvFrom(env: NodeJS.ProcessEnv): MailEnv {
  // Empty counts as missing. `??` does not fire on "" and an env var is empty
  // far more often than it is absent — a bare `JMAP_USER=` line in .env.prod, a
  // compose file interpolating a variable that was never set, a wrapper
  // exporting the name with no value — the same three ways
  // `ownMailboxAddresses` records. There is no legitimate reading of an empty
  // credential; authenticating as nobody must fail here rather than at the
  // server, where it arrives as a 401 indistinguishable from a wrong password.
  //
  // EVERY missing name at once. Reporting only the first costs an operator a
  // whole deploy cycle per variable, and this path is exercised precisely when
  // someone is filling the values in for the first time.
  const missing = REQUIRED.filter((name) => !env[name]?.trim());
  if (missing.length > 0) throw new MailEnvError([...missing]);

  return {
    // ONE trailing slash, because `openSession` concatenates
    // `${base}/.well-known/jmap` — `http://stalwart:8080/` then dials
    // `//.well-known/jmap`, which some routers serve and others 404, so it fails
    // in production and not in whatever was tried by hand.
    baseUrl: env.JMAP_BASE_URL!.trim().replace(/\/$/, ""),
    user: env.JMAP_USER!.trim(),
    // NOT trimmed. Leading or trailing whitespace is not plausibly a typo in a
    // generated app password, and trimming would send a DIFFERENT credential
    // than the one configured while reporting success — a wrong password is the
    // one thing this function must never invent.
    appPassword: env.JMAP_APP_PASSWORD!,
  };
}

export async function openMailPort(
  env: NodeJS.ProcessEnv,
  opts?: { limits?: Partial<JmapPortLimits>; onDateFallback?: (n: MailDateFallback) => void },
): Promise<MailPort> {
  const { baseUrl, user, appPassword } = mailEnvFrom(env);
  // `basic`, never `bearer`: Stalwart is authenticated with HTTP Basic and an
  // app password. The credential is built once and handed to BOTH the session
  // fetch and the port, so `call` and `download` cannot drift apart from it.
  const auth = basic(user, appPassword);
  const session = await openSession(baseUrl, auth);
  return makeJmapPort({ session, auth, call, download, ...opts });
}
