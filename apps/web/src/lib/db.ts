import { createDb } from "@verder/db";

// One pg pool per process (survives Next.js dev HMR module reloads).
const g = globalThis as unknown as { __verderDb?: ReturnType<typeof createDb> };

export function getDb(): ReturnType<typeof createDb> {
  g.__verderDb ??= createDb(process.env.DATABASE_URL!);
  return g.__verderDb;
}
