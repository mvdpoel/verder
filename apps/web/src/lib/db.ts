import { createDb } from "@grip/db";

// One pg pool per process (survives Next.js dev HMR module reloads).
const g = globalThis as unknown as { __gripDb?: ReturnType<typeof createDb> };

export function getDb(): ReturnType<typeof createDb> {
  g.__gripDb ??= createDb(process.env.DATABASE_URL!);
  return g.__gripDb;
}
