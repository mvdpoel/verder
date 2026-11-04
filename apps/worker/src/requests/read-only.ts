import { sql } from "drizzle-orm";
import type { Db } from "@grip/db";

/**
 * READING IS ENFORCED, NOT PROMISED (Vraag Grip spec, "The laws this must keep").
 *
 * Every grip-tools tool runs its queries through here: one transaction, made
 * `READ ONLY` before its first query, so Postgres itself refuses an INSERT,
 * UPDATE or DELETE — even one a buggy tool, or a function it calls, tries to
 * make. The connection is the worker's, whose grants are wider than reading;
 * this is what narrows them for the duration of a tool call.
 *
 * The transaction is ALWAYS ROLLED BACK. A read-only one has nothing to commit,
 * and rolling back is also what keeps it correct when `db` is itself a
 * transaction (a test's isolated fixture, or any caller's): the nested call is
 * a SAVEPOINT, and `SET TRANSACTION READ ONLY` inside a savepoint stays in force
 * after a RELEASE but is undone by ROLLBACK TO SAVEPOINT — measured on PG 17.
 */
class ReadOnlyDone<T> extends Error {
  constructor(readonly value: T) { super("read-only transaction done"); }
}

export async function runReadOnly<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  try {
    await db.transaction(async (raw) => {
      const tx = raw as unknown as Db;
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      throw new ReadOnlyDone(await fn(tx));
    });
  } catch (err) {
    if (err instanceof ReadOnlyDone) return err.value as T;
    throw err;
  }
  throw new Error("runReadOnly: the transaction returned without a result");
}
