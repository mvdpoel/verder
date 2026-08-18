import { schema, type Db } from "@verder/db";

export async function recordRun(
  db: Db,
  worker: string,
  status: "ok" | "error",
  detail?: unknown,
): Promise<void> {
  await db.insert(schema.workerRuns).values({
    worker,
    status,
    detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail)),
  });
}
