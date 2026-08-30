import { notFound } from "next/navigation";

/**
 * Is this the router saying "no such record", as opposed to something breaking?
 *
 * DUCK-TYPED on `code`, not `instanceof TRPCError`. The web app and the api
 * package can each resolve their own copy of `@trpc/server` — pnpm's layout
 * makes that a question about the lockfile rather than about this code — and an
 * `instanceof` that silently stops matching would turn every missing record
 * back into the crash page this exists to prevent.
 *
 * Nothing else is treated as NOT_FOUND. A failed query, a dead session and a
 * bad input are all real failures and must reach the error boundary, which says
 * so; quietly rendering them as "page does not exist" would hide an outage
 * behind a 404.
 */
export function isNotFoundError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err
    && (err as { code?: unknown }).code === "NOT_FOUND";
}

/**
 * Await a router call, and render the 404 page if the record is not there.
 *
 * A stale bookmark to a document that was never ingested, a mistyped UUID, a
 * link from an old export — all of these used to reach Next's default error
 * page, which in production reads "Application error: a server-side exception
 * has occurred" in English with no way back. For an app whose whole claim is
 * that the record can be trusted, an unstyled crash is the worst answer
 * available; "this page does not exist" is the true one.
 */
export async function orNotFound<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    // notFound() throws its own control-flow signal, so this never returns.
    if (isNotFoundError(err)) notFound();
    throw err;
  }
}
