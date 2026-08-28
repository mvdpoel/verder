/**
 * How long a session lives, decided per sign-in.
 *
 * This is its own module, published as the `@verder/auth/session-trust`
 * subpath, because the login page needs the header name and the barrel reaches
 * better-auth's server code and the drizzle adapter — fine on the server,
 * dead weight in a browser bundle. Same reason `@verder/parsers/sheet-mimes`
 * exists.
 *
 * Nothing here touches a database or a request; it is a decision about a
 * header, so it is testable without either.
 */

/** Set by the login page when Martin ticks "trust this device for 30 days". */
export const TRUST_HEADER = "x-verder-trust-device";

export const TRUSTED_SESSION_SECONDS = 60 * 60 * 24 * 30;
export const UNTRUSTED_SESSION_SECONDS = 60 * 60 * 12;

/**
 * Exactly "1" counts. Anything else — a missing header, an empty value, a
 * "true" from some future caller that guessed — falls to the short session.
 * The failure direction matters: guessing wrong toward 30 days leaves a
 * session alive on a borrowed browser for a month.
 */
export function isTrustedRequest(headers: Headers | null | undefined): boolean {
  return headers?.get(TRUST_HEADER) === "1";
}

export function sessionExpiryFor(
  headers: Headers | null | undefined,
  now: Date = new Date(),
): Date {
  const seconds = isTrustedRequest(headers)
    ? TRUSTED_SESSION_SECONDS
    : UNTRUSTED_SESSION_SECONDS;
  return new Date(now.getTime() + seconds * 1000);
}
