import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "./client";
import * as schema from "./schema";

// `passkey` is auth infrastructure, not evidence: it appends no ledger event
// and /verify never reads it. So unlike every evidence table in this project,
// the app role is allowed to DELETE — removing a credential has to actually
// remove it. The worker has no business here at all.
const OWNER_URL = "postgres://verder:verder@localhost:5432/verder";
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";
const WORKER_URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

describe("passkey table", () => {
  let owner: Db, app: Db, worker: Db;
  let ownerPool: ReturnType<typeof createDb>["pool"];
  let appPool: ReturnType<typeof createDb>["pool"];
  let workerPool: ReturnType<typeof createDb>["pool"];
  const userId = `test-user-${crypto.randomUUID()}`;

  beforeAll(async () => {
    ({ db: owner, pool: ownerPool } = createDb(OWNER_URL));
    ({ db: app, pool: appPool } = createDb(APP_URL));
    ({ db: worker, pool: workerPool } = createDb(WORKER_URL));
    await owner.insert(schema.user).values({
      id: userId, name: "Passkey Test", email: `${userId}@example.test`,
    });
  });

  afterAll(async () => {
    await owner.delete(schema.user).where(eq(schema.user.id, userId));
    await ownerPool.end();
    await appPool.end();
    await workerPool.end();
  });

  it("lets the app role insert, read, update and delete a passkey", async () => {
    const id = crypto.randomUUID();
    const [pk] = await app.insert(schema.passkey).values({
      id,
      name: "MacBook Touch ID",
      publicKey: "cHVibGljLWtleQ",
      userId,
      credentialID: `cred-${id}`,
      counter: 0,
      deviceType: "singleDevice",
      backedUp: true,
      transports: "internal,hybrid",
    }).returning();
    expect(pk.credentialID).toBe(`cred-${id}`);
    expect(pk.backedUp).toBe(true);

    await app.update(schema.passkey).set({ name: "MacBook" })
      .where(eq(schema.passkey.id, id));
    const [renamed] = await app.select().from(schema.passkey)
      .where(eq(schema.passkey.id, id));
    expect(renamed.name).toBe("MacBook");

    await app.delete(schema.passkey).where(eq(schema.passkey.id, id));
    const left = await app.select().from(schema.passkey)
      .where(eq(schema.passkey.id, id));
    expect(left).toHaveLength(0);
  });

  it("keeps the worker role out entirely", async () => {
    await expect(worker.select().from(schema.passkey)).rejects.toThrow(/permission denied/i);
  });

  it("accepts a null name, transports and aaguid — Apple zeroes the AAGUID", async () => {
    const id = crypto.randomUUID();
    const [pk] = await app.insert(schema.passkey).values({
      id, publicKey: "cHVibGljLWtleQ", userId, credentialID: `cred-${id}`,
      counter: 0, deviceType: "singleDevice", backedUp: false,
    }).returning();
    expect(pk.name).toBeNull();
    expect(pk.aaguid).toBeNull();
    await app.delete(schema.passkey).where(eq(schema.passkey.id, id));
  });
});
