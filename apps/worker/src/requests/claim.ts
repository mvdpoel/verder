import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@grip/db";
import { buildRequestPrompt, loadPromptInput, REQUEST_PROMPT_VERSION } from "./prompt";
import { resetStuck } from "./store";

/**
 * ONE REQUEST AT A TIME (Vraag Grip spec, "Limits and failure").
 *
 * `claimNext` takes the OLDEST queued request — FOR UPDATE SKIP LOCKED, so two
 * runners can never take the same one — builds its prompt HERE, in the worker,
 * and stores it on the row in the same transaction that moves it to `working`:
 * `requests.prompt` always records the exact prompt the model saw. First it
 * resets any request left `working` for more than 15 minutes by a dead runner.
 */
export async function claimNext(
  db: Db, now = new Date(), opts: { onlyId?: string } = {},
): Promise<{ id: string | null; reset: string[] }> {
  const reset = await resetStuck(db, now);
  const id = await db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    // `onlyId` is the dry-run harness's: it claims the request it made, never
    // one Martin queued on the shared dev database.
    const only = opts.onlyId ? sql`AND id = ${opts.onlyId}::uuid` : sql``;
    const rows = (await tx.execute(sql`SELECT id FROM requests WHERE status = 'queued' ${only}
      ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows as { id: string }[];
    if (rows.length === 0) return null;
    const input = await loadPromptInput(tx, rows[0].id, now);
    if (!input) return null;
    await tx.update(schema.requests).set({
      status: "working", claimedAt: now, prompt: buildRequestPrompt(input),
      promptVersion: REQUEST_PROMPT_VERSION, toolLog: [], updatedAt: now,
    }).where(and(eq(schema.requests.id, rows[0].id), eq(schema.requests.status, "queued")));
    return rows[0].id;
  });
  return { id, reset };
}

/** The stored prompt of a request that is still `working`, else null. */
export async function promptFor(db: Db, id: string): Promise<string | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const [r] = await db.select({ status: schema.requests.status, prompt: schema.requests.prompt })
    .from(schema.requests).where(eq(schema.requests.id, id));
  return r && r.status === "working" ? r.prompt : null;
}
