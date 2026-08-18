import { createDb, schema } from "@verder/db";
import { eq } from "drizzle-orm";
import { createAuth } from "./index";

const email = process.env.SEED_EMAIL ?? "martin@vanderpoel.pro";
const password = process.env.SEED_PASSWORD;
if (!password) { console.error("Set SEED_PASSWORD"); process.exit(1); }

const { db, pool } = createDb(process.env.DATABASE_URL ?? "postgres://verder:verder@localhost:5432/verder");
process.env.ALLOW_SIGNUP = "1";
const auth = createAuth({
  db,
  secret: process.env.AUTH_SECRET ?? "change-me",
  baseURL: process.env.APP_URL ?? "http://localhost:3000",
});
const existingAuthUser = await db.select().from(schema.user).where(eq(schema.user.email, email));
if (existingAuthUser.length === 0) {
  await auth.api.signUpEmail({ body: { email, password, name: "Martin van der Poel" } });
} else {
  console.log(`better-auth user already exists for ${email}, skipping sign-up`);
}
const existing = await db.select().from(schema.users).where(eq(schema.users.email, email));
if (existing.length === 0)
  await db.insert(schema.users).values({ email, name: "Martin van der Poel" });
const [u] = await db.select().from(schema.users).where(eq(schema.users.email, email));
console.log(`Seeded user ${u.id} (${email})`);
await pool.end();
