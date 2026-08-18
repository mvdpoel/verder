import { createAuth } from "@verder/auth";
import { getDb } from "./db";

// One better-auth instance per process (shares the singleton db pool).
const g = globalThis as unknown as { __verderAuth?: ReturnType<typeof createAuth> };

export function getAuth(): ReturnType<typeof createAuth> {
  g.__verderAuth ??= createAuth({
    db: getDb().db,
    secret: process.env.AUTH_SECRET!,
    baseURL: process.env.APP_URL ?? "http://localhost:3000",
  });
  return g.__verderAuth;
}
