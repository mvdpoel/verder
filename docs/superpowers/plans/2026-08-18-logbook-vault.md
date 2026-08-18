# Logbook + Document Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the tamper-evident logbook + document vault web app (single user: Martin) with Gmail/NAS watchers and an Ollama suggestion pipeline, deployed via Docker on the homelab.

**Architecture:** Modular monolith in a pnpm/Turborepo monorepo. Postgres is the single source of truth with insert-only evidence tables and one global SHA-256 hash-chain ledger (`ledger_events`); files are content-addressed on disk. All writes go through tRPC routers in `packages/api` (entity insert + ledger append in one transaction). A separate worker process (`apps/worker`) runs Gmail/NAS watchers and the Ollama pipeline via pg-boss.

**Tech Stack:** Next.js 15 (App Router, React 19), tRPC v11, Drizzle ORM, Postgres 17, pg-boss, better-auth, Vitest, Docker Compose, Ollama (local), googleapis (Gmail).

**Spec:** `docs/superpowers/specs/2026-08-18-logbook-vault-design.md`

## Global Constraints

- Evidence tables (`ledger_events`, `log_entries`, `parties`, `entry_participants`, `documents`, `entry_documents`, `action_items`) are **insert-only**: the app's DB role gets no UPDATE/DELETE grants on them.
- Every mutation of an evidence entity appends a `ledger_events` row **in the same transaction**.
- Ledger appends are serialized (advisory lock) — the chain must never fork.
- Canonical JSON serialization must be deterministic (sorted keys, no whitespace) — hash stability is critical.
- Ingestion is idempotent: Gmail message id and file sha256 are uniqueness keys.
- Raw sources (emails, files) are persisted **before** any AI processing.
- AI output is suggestion-only; nothing enters the ledger without explicit approval. Model name + prompt version + verdict + edit diff are stored (golden rule).
- AI runs on local Ollama only (base URL from `OLLAMA_URL` env).
- UI copy towards Martin: supportive, encouraging, judgement-free. (Single-user v1, so all copy uses this register.)
- All timestamps stored as `timestamptz` UTC. Two time fields matter on entries: `occurred_at` (when it happened) and `recorded_at` (when logged).
- TypeScript strict mode everywhere; no `any` in committed code.
- Node 22, pnpm 9. Package names: `@verder/core`, `@verder/db`, `@verder/api`, `@verder/auth`.

## File Structure

```
verder/
├── package.json                  # pnpm workspace root, turbo
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── docker-compose.yml            # postgres for dev; full stack for prod (Task 20)
├── .env.example
├── packages/
│   ├── core/                     # pure functions, zero deps on db/net
│   │   └── src/
│   │       ├── canonical-json.ts # canonicalJson(obj): string
│   │       ├── hash.ts           # sha256Hex, computeEventHash
│   │       ├── verify.ts         # verifyChain(events): VerifyResult
│   │       └── index.ts
│   ├── db/
│   │   └── src/
│   │       ├── schema.ts         # all Drizzle tables
│   │       ├── client.ts         # createDb(url)
│   │       └── index.ts
│   │   └── drizzle/              # generated SQL migrations + 0002_grants.sql
│   ├── api/
│   │   └── src/
│   │       ├── trpc.ts           # initTRPC, context, protectedProcedure
│   │       ├── ledger.ts         # appendLedgerEvent(tx, input)
│   │       ├── routers/
│   │       │   ├── entries.ts    # create, list, get, correct
│   │       │   ├── parties.ts    # create, list
│   │       │   ├── documents.ts  # registerUpload, list, get, file, link
│   │       │   ├── suggestions.ts# list, approve, reject
│   │       │   └── verify.ts     # runVerification, exportRange
│   │       ├── storage.ts        # storeFile(buf): {sha256, path} content-addressed
│   │       └── root.ts           # appRouter
│   └── auth/
│       └── src/index.ts          # better-auth config + seed script
├── apps/
│   ├── web/                      # Next.js 15
│   │   └── src/app/
│   │       ├── (auth)/login/page.tsx
│   │       ├── dashboard/page.tsx
│   │       ├── logbook/page.tsx  + logbook/[id]/page.tsx + logbook/new/page.tsx
│   │       ├── vault/page.tsx    + vault/[id]/page.tsx
│   │       ├── queue/page.tsx
│   │       ├── verify/page.tsx
│   │       └── api/trpc/[trpc]/route.ts + api/auth/[...all]/route.ts + api/files/[sha256]/route.ts
│   └── worker/
│       └── src/
│           ├── index.ts          # boots pg-boss, schedules jobs
│           ├── heartbeat.ts      # recordRun(db, worker, status, detail)
│           ├── gmail.ts          # pollGmail(deps)
│           ├── nas.ts            # scanNasFolder(deps)
│           ├── ollama.ts         # generateSuggestion(deps, item)
│           └── prompts.ts        # PROMPT_VERSION, buildEntryPrompt()
```

Tasks 1–5 build the foundation (repo, db, hashing, ledger). Tasks 6–10 build the API + auth + web shell. Tasks 11–14 build the web pages. Tasks 15–19 build the worker. Task 20 ships deployment.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.gitignore`, `.env.example`, `docker-compose.yml`

**Interfaces:**
- Produces: workspace layout `packages/*`, `apps/*`; `pnpm test` / `pnpm build` via turbo; dev Postgres at `postgres://verder:verder@localhost:5432/verder`.

- [ ] **Step 1: Create workspace files**

`package.json`:
```json
{
  "name": "verder",
  "private": true,
  "packageManager": "pnpm@9.15.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "turbo build",
    "test": "turbo test",
    "dev": "turbo dev",
    "typecheck": "turbo typecheck"
  },
  "devDependencies": { "turbo": "^2.3.0", "typescript": "^5.7.2" }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "apps/*"
```

`turbo.json`:
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**"] },
    "test": { "dependsOn": ["^build"] },
    "typecheck": { "dependsOn": ["^build"] },
    "dev": { "cache": false, "persistent": true }
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true
  }
}
```

`.gitignore`:
```
node_modules/
dist/
.next/
.env
.turbo/
vault-files/
```

`.env.example`:
```
DATABASE_URL=postgres://verder:verder@localhost:5432/verder
VAULT_DIR=./vault-files
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:14b
GMAIL_CREDENTIALS_PATH=./secrets/gmail-oauth.json
GMAIL_TOKEN_PATH=./secrets/gmail-token.json
NAS_SCAN_DIR=/mnt/nas/scans
AUTH_SECRET=change-me
APP_URL=http://localhost:3000
```

`docker-compose.yml` (dev DB only for now; Task 20 extends it):
```yaml
services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_USER: verder
      POSTGRES_PASSWORD: verder
      POSTGRES_DB: verder
    ports: ["5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]
volumes:
  pgdata:
```

- [ ] **Step 2: Verify workspace resolves**

Run: `pnpm install && docker compose up -d postgres && pnpm exec turbo --version`
Expected: install succeeds, turbo prints a version, `docker compose ps` shows postgres healthy.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "chore: scaffold pnpm/turbo monorepo with dev postgres"
```

### Task 2: `@verder/core` — canonical JSON + hashing

**Files:**
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/canonical-json.ts`, `packages/core/src/hash.ts`, `packages/core/src/index.ts`
- Test: `packages/core/src/canonical-json.test.ts`, `packages/core/src/hash.test.ts`

**Interfaces:**
- Produces:
  - `canonicalJson(value: unknown): string` — deterministic JSON: object keys sorted recursively, no whitespace, rejects `undefined`/functions/NaN (throws `TypeError`).
  - `sha256Hex(data: string | Uint8Array): string` — lowercase hex.
  - `computeEventHash(e: { seq: number; eventType: string; entityType: string; entityId: string; payloadHash: string; prevHash: string }): string` — sha256 of canonical JSON of exactly those six fields.
  - `GENESIS_HASH = "0".repeat(64)`

- [ ] **Step 1: Package scaffold**

`packages/core/package.json`:
```json
{
  "name": "@verder/core",
  "version": "0.0.1",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit", "build": "tsc --noEmit" },
  "devDependencies": { "vitest": "^2.1.8", "typescript": "^5.7.2" }
}
```

`packages/core/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

- [ ] **Step 2: Write failing tests**

`packages/core/src/canonical-json.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json";

describe("canonicalJson", () => {
  it("sorts keys recursively and emits no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: "x" } }))
      .toBe('{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}');
  });
  it("is stable regardless of key insertion order", () => {
    const one = canonicalJson({ a: 1, b: 2 });
    const two = canonicalJson({ b: 2, a: 1 });
    expect(one).toBe(two);
  });
  it("rejects undefined and NaN", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(TypeError);
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
  });
});
```

`packages/core/src/hash.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { computeEventHash, GENESIS_HASH, sha256Hex } from "./hash";

describe("hashing", () => {
  it("sha256Hex matches known vector", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
  it("computeEventHash is order-independent on input object", () => {
    const e = { seq: 1, eventType: "entry.created", entityType: "log_entry",
      entityId: "00000000-0000-0000-0000-000000000001",
      payloadHash: sha256Hex("p"), prevHash: GENESIS_HASH };
    expect(computeEventHash(e)).toMatch(/^[0-9a-f]{64}$/);
    expect(computeEventHash({ ...e })).toBe(computeEventHash(e));
  });
  it("changes when any field changes", () => {
    const e = { seq: 1, eventType: "entry.created", entityType: "log_entry",
      entityId: "id", payloadHash: sha256Hex("p"), prevHash: GENESIS_HASH };
    expect(computeEventHash({ ...e, seq: 2 })).not.toBe(computeEventHash(e));
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @verder/core test`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

`packages/core/src/canonical-json.ts`:
```ts
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(v: unknown): string {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "string") return JSON.stringify(v);
  if (t === "boolean") return v ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(v as number)) throw new TypeError("Non-finite number in canonical JSON");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(serialize).join(",")}]`;
  if (t === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => {
        if (val === undefined) throw new TypeError("undefined value in canonical JSON");
        return true;
      })
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${serialize(val)}`).join(",")}}`;
  }
  throw new TypeError(`Unsupported type in canonical JSON: ${t}`);
}
```

`packages/core/src/hash.ts`:
```ts
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json";

export const GENESIS_HASH = "0".repeat(64);

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface EventHashInput {
  seq: number;
  eventType: string;
  entityType: string;
  entityId: string;
  payloadHash: string;
  prevHash: string;
}

export function computeEventHash(e: EventHashInput): string {
  const { seq, eventType, entityType, entityId, payloadHash, prevHash } = e;
  return sha256Hex(canonicalJson({ seq, eventType, entityType, entityId, payloadHash, prevHash }));
}
```

`packages/core/src/index.ts`:
```ts
export { canonicalJson } from "./canonical-json";
export { GENESIS_HASH, sha256Hex, computeEventHash, type EventHashInput } from "./hash";
export { verifyChain, type ChainEvent, type VerifyResult } from "./verify";
```
(The `verify` export lands in Task 3 — create `src/verify.ts` with empty exports now so the barrel compiles: `export type ChainEvent = never; export type VerifyResult = never; export function verifyChain(): never { throw new Error("not implemented"); }` is NOT acceptable — instead, omit the verify line from `index.ts` in this task and add it in Task 3.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @verder/core test`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core && git commit -m "feat(core): canonical JSON and event hashing"
```

### Task 3: `@verder/core` — chain verifier

**Files:**
- Create: `packages/core/src/verify.ts`
- Modify: `packages/core/src/index.ts` (add verify export line shown in Task 2)
- Test: `packages/core/src/verify.test.ts`

**Interfaces:**
- Consumes: `computeEventHash`, `GENESIS_HASH` from Task 2.
- Produces:
  - `interface ChainEvent { seq: number; eventType: string; entityType: string; entityId: string; payloadHash: string; prevHash: string; eventHash: string }`
  - `type VerifyResult = { ok: true; count: number } | { ok: false; brokenAtSeq: number; reason: "gap" | "prev_hash_mismatch" | "event_hash_mismatch" | "payload_hash_mismatch" }`
  - `verifyChain(events: ChainEvent[], recomputePayloadHash?: (e: ChainEvent) => string | Promise<string>): Promise<VerifyResult>` — events must be seq-ascending starting at 1; optional callback recomputes each payload hash from the live entity/file and compares.

- [ ] **Step 1: Write failing tests (property-style tampering)**

`packages/core/src/verify.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { computeEventHash, GENESIS_HASH, sha256Hex } from "./hash";
import { verifyChain, type ChainEvent } from "./verify";

function buildChain(n: number): ChainEvent[] {
  const events: ChainEvent[] = [];
  let prevHash = GENESIS_HASH;
  for (let seq = 1; seq <= n; seq++) {
    const base = { seq, eventType: "entry.created", entityType: "log_entry",
      entityId: `id-${seq}`, payloadHash: sha256Hex(`payload-${seq}`), prevHash };
    const eventHash = computeEventHash(base);
    events.push({ ...base, eventHash });
    prevHash = eventHash;
  }
  return events;
}

describe("verifyChain", () => {
  it("accepts a valid chain", async () => {
    expect(await verifyChain(buildChain(10))).toEqual({ ok: true, count: 10 });
  });
  it("accepts an empty chain", async () => {
    expect(await verifyChain([])).toEqual({ ok: true, count: 0 });
  });
  it("detects tampering with ANY field of ANY event", async () => {
    const fields = ["eventType", "entityType", "entityId", "payloadHash", "prevHash", "eventHash"] as const;
    for (let i = 0; i < 10; i++) {
      for (const f of fields) {
        const chain = buildChain(10);
        chain[i] = { ...chain[i], [f]: f === "eventType" ? "tampered" : "f".repeat(64) };
        const res = await verifyChain(chain);
        expect(res.ok, `tamper ${f}@${i} must fail`).toBe(false);
        if (!res.ok) expect(res.brokenAtSeq).toBeLessThanOrEqual(i + 2);
      }
    }
  });
  it("detects a deleted (gap) event", async () => {
    const chain = buildChain(5);
    chain.splice(2, 1);
    const res = await verifyChain(chain);
    expect(res).toMatchObject({ ok: false, reason: "gap", brokenAtSeq: 4 });
  });
  it("recomputes payload hashes when callback given", async () => {
    const chain = buildChain(3);
    const res = await verifyChain(chain, (e) =>
      e.seq === 2 ? "e".repeat(64) : e.payloadHash);
    expect(res).toMatchObject({ ok: false, reason: "payload_hash_mismatch", brokenAtSeq: 2 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @verder/core test verify`
Expected: FAIL — `./verify` not found.

- [ ] **Step 3: Implement**

`packages/core/src/verify.ts`:
```ts
import { computeEventHash, GENESIS_HASH } from "./hash";

export interface ChainEvent {
  seq: number; eventType: string; entityType: string; entityId: string;
  payloadHash: string; prevHash: string; eventHash: string;
}

export type VerifyResult =
  | { ok: true; count: number }
  | { ok: false; brokenAtSeq: number;
      reason: "gap" | "prev_hash_mismatch" | "event_hash_mismatch" | "payload_hash_mismatch" };

export async function verifyChain(
  events: ChainEvent[],
  recomputePayloadHash?: (e: ChainEvent) => string | Promise<string>
): Promise<VerifyResult> {
  let prevHash = GENESIS_HASH;
  let expectedSeq = 1;
  for (const e of events) {
    if (e.seq !== expectedSeq)
      return { ok: false, brokenAtSeq: e.seq, reason: "gap" };
    if (e.prevHash !== prevHash)
      return { ok: false, brokenAtSeq: e.seq, reason: "prev_hash_mismatch" };
    const { eventHash: _stored, ...rest } = e;
    if (computeEventHash(rest) !== e.eventHash)
      return { ok: false, brokenAtSeq: e.seq, reason: "event_hash_mismatch" };
    if (recomputePayloadHash) {
      const live = await recomputePayloadHash(e);
      if (live !== e.payloadHash)
        return { ok: false, brokenAtSeq: e.seq, reason: "payload_hash_mismatch" };
    }
    prevHash = e.eventHash;
    expectedSeq++;
  }
  return { ok: true, count: events.length };
}
```

Add to `packages/core/src/index.ts`:
```ts
export { verifyChain, type ChainEvent, type VerifyResult } from "./verify";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @verder/core test`
Expected: PASS (all core tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core && git commit -m "feat(core): hash-chain verifier with tamper detection"
```

### Task 4: `@verder/db` — schema + migrations

**Files:**
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/drizzle.config.ts`, `packages/db/src/schema.ts`, `packages/db/src/client.ts`, `packages/db/src/index.ts`
- Test: `packages/db/src/schema.test.ts` (integration, needs dev postgres up)

**Interfaces:**
- Consumes: dev Postgres from Task 1.
- Produces:
  - All tables as Drizzle objects: `ledgerEvents`, `logEntries`, `parties`, `entryParticipants`, `documents`, `entryDocuments`, `actionItems`, `suggestions`, `users`, `workerRuns`, `rawEmails`.
  - `createDb(url: string): { db: NodePgDatabase<typeof schema>; pool: Pool }`
  - Scripts: `pnpm --filter @verder/db migrate` (drizzle-kit migrate), `pnpm --filter @verder/db generate`.

- [ ] **Step 1: Package scaffold**

`packages/db/package.json`:
```json
{
  "name": "@verder/db",
  "version": "0.0.1",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "generate": "drizzle-kit generate",
    "migrate": "drizzle-kit migrate",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "build": "tsc --noEmit"
  },
  "dependencies": { "drizzle-orm": "^0.38.0", "pg": "^8.13.1", "@verder/core": "workspace:*" },
  "devDependencies": { "drizzle-kit": "^0.30.0", "vitest": "^2.1.8", "@types/pg": "^8.11.10", "typescript": "^5.7.2" }
}
```

`packages/db/drizzle.config.ts`:
```ts
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://verder:verder@localhost:5432/verder" },
});
```

- [ ] **Step 2: Write the schema**

`packages/db/src/schema.ts`:
```ts
import { bigint, boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const channelEnum = pgEnum("channel", ["call", "meeting", "email", "whatsapp", "voicemail", "letter", "other"]);
export const directionEnum = pgEnum("direction", ["inbound", "outbound", "internal"]);
export const entrySourceEnum = pgEnum("entry_source", ["manual", "gmail-watch", "nas-watch"]);
export const docSourceEnum = pgEnum("doc_source", ["upload", "nas-scan", "email-attachment"]);
export const docStatusEnum = pgEnum("doc_status", ["inbox", "filed"]);
export const partyKindEnum = pgEnum("party_kind", ["person", "organization"]);
export const clarityEnum = pgEnum("clarity", ["clear", "ambiguous", "already-provided"]);
export const actionStatusEnum = pgEnum("action_status", ["open", "done", "cancelled"]);
export const suggestionKindEnum = pgEnum("suggestion_kind", ["log-entry", "document-meta"]);
export const suggestionStatusEnum = pgEnum("suggestion_status", ["pending", "approved", "edited", "rejected", "needs-manual"]);

export const ledgerEvents = pgTable("ledger_events", {
  seq: bigint("seq", { mode: "number" }).primaryKey(),
  eventType: text("event_type").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  payloadHash: text("payload_hash").notNull(),
  prevHash: text("prev_hash").notNull(),
  eventHash: text("event_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("ledger_entity_idx").on(t.entityType, t.entityId)]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const parties = pgTable("parties", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: partyKindEnum("kind").notNull(),
  name: text("name").notNull(),
  organization: text("organization"),
  email: text("email"),
  phone: text("phone"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const logEntries = pgTable("log_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  channel: channelEnum("channel").notNull(),
  direction: directionEnum("direction").notNull(),
  summary: text("summary").notNull(),
  details: text("details"),
  source: entrySourceEnum("source").notNull(),
  sourceRef: text("source_ref"),
  supersedesId: uuid("supersedes_id"),
  createdBy: uuid("created_by").notNull().references(() => users.id),
}, (t) => [index("entries_occurred_idx").on(t.occurredAt)]);

export const entryParticipants = pgTable("entry_participants", {
  entryId: uuid("entry_id").notNull().references(() => logEntries.id),
  partyId: uuid("party_id").notNull().references(() => parties.id),
}, (t) => [uniqueIndex("entry_party_uq").on(t.entryId, t.partyId)]);

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  sha256: text("sha256").notNull().unique(),
  title: text("title").notNull(),
  docType: text("doc_type"),
  mime: text("mime").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  source: docSourceEnum("source").notNull(),
  sourceRef: text("source_ref"),
  status: docStatusEnum("status").notNull().default("inbox"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const documentStatusChanges = pgTable("document_status_changes", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id").notNull().references(() => documents.id),
  status: docStatusEnum("status").notNull(),
  title: text("title"),
  docType: text("doc_type"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const entryDocuments = pgTable("entry_documents", {
  entryId: uuid("entry_id").notNull().references(() => logEntries.id),
  documentId: uuid("document_id").notNull().references(() => documents.id),
}, (t) => [uniqueIndex("entry_doc_uq").on(t.entryId, t.documentId)]);

export const actionItems = pgTable("action_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  entryId: uuid("entry_id").notNull().references(() => logEntries.id),
  ownerPartyId: uuid("owner_party_id").references(() => parties.id),
  description: text("description").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }),
  clarity: clarityEnum("clarity").notNull().default("clear"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const actionItemStatusChanges = pgTable("action_item_status_changes", {
  id: uuid("id").primaryKey().defaultRandom(),
  actionItemId: uuid("action_item_id").notNull().references(() => actionItems.id),
  status: actionStatusEnum("status").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rawEmails = pgTable("raw_emails", {
  id: uuid("id").primaryKey().defaultRandom(),
  gmailMessageId: text("gmail_message_id").notNull().unique(),
  gmailThreadId: text("gmail_thread_id").notNull(),
  fromAddr: text("from_addr").notNull(),
  toAddr: text("to_addr").notNull(),
  subject: text("subject").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
  rawRfc822Sha256: text("raw_rfc822_sha256").notNull(),
  bodyText: text("body_text").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

export const suggestions = pgTable("suggestions", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: suggestionKindEnum("kind").notNull(),
  status: suggestionStatusEnum("status").notNull().default("pending"),
  rawEmailId: uuid("raw_email_id").references(() => rawEmails.id),
  documentId: uuid("document_id").references(() => documents.id),
  model: text("model"),
  promptVersion: text("prompt_version"),
  proposed: jsonb("proposed"),
  finalPayload: jsonb("final_payload"),
  resultEntryId: uuid("result_entry_id"),
  verdictAt: timestamp("verdict_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workerRuns = pgTable("worker_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  worker: text("worker").notNull(),
  status: text("status").notNull(),
  detail: jsonb("detail"),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("worker_runs_idx").on(t.worker, t.ranAt)]);
```

Note: `suggestions`, `workerRuns`, `documentStatusChanges`, `actionItemStatusChanges`, and `rawEmails` are operational tables — they MAY be updated (`suggestions.status` flips on verdict). Evidence tables listed in Global Constraints are the insert-only set. Status changes on evidence entities are modeled as insert-only child tables (`document_status_changes`, `action_item_status_changes`) — current status on the parent row is set once at insert and then read via "latest child row wins"; the API layer resolves effective status.

Correction to the above for implementers: `documents.status` and similar parent columns are convenience defaults only valid at creation. Effective status = latest row in the corresponding `*_status_changes` table, falling back to the parent column when no child rows exist.

`packages/db/src/client.ts`:
```ts
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

export function createDb(url: string): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: url });
  return { db: drizzle(pool, { schema }), pool };
}
```

`packages/db/src/index.ts`:
```ts
export * as schema from "./schema";
export { createDb, type Db } from "./client";
```

- [ ] **Step 3: Generate + run migration; write smoke test**

Run: `pnpm --filter @verder/db generate && pnpm --filter @verder/db migrate`

`packages/db/src/schema.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createDb } from "./client";
import * as schema from "./schema";

const url = process.env.DATABASE_URL ?? "postgres://verder:verder@localhost:5432/verder";

describe("schema", () => {
  it("inserts and reads a party", async () => {
    const { db, pool } = createDb(url);
    const [p] = await db.insert(schema.parties)
      .values({ kind: "organization", name: "VerderGroep" }).returning();
    expect(p.id).toBeTruthy();
    const found = await db.select().from(schema.parties);
    expect(found.some((r) => r.id === p.id)).toBe(true);
    await pool.end();
  });
});
```

Run: `pnpm --filter @verder/db test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/db && git commit -m "feat(db): full drizzle schema and initial migration"
```

### Task 5: Append-only enforcement + ledger append service

**Files:**
- Create: `packages/db/drizzle/0002_grants.sql` (hand-written migration), `packages/api/package.json`, `packages/api/tsconfig.json`, `packages/api/src/ledger.ts`
- Test: `packages/api/src/ledger.test.ts` (integration)

**Interfaces:**
- Consumes: `@verder/core` (hashing), `@verder/db` (schema, createDb).
- Produces:
  - DB role `verder_app` (password env `APP_DB_PASSWORD`, dev default `verder_app`): INSERT+SELECT only on evidence tables; INSERT+SELECT+UPDATE on operational tables; no DELETE anywhere.
  - `appendLedgerEvent(tx: Db, input: { eventType: string; entityType: string; entityId: string; payload: unknown }): Promise<{ seq: number; eventHash: string }>` — takes `pg_advisory_xact_lock(42)`, reads chain head, computes hashes via core, inserts. MUST be called inside the same transaction as the entity insert.

- [ ] **Step 1: Write the grants migration**

`packages/db/drizzle/0002_grants.sql` (append to drizzle journal via `drizzle-kit generate --custom`, name it `grants`):
```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'verder_app') THEN
    CREATE ROLE verder_app LOGIN PASSWORD 'verder_app';
  END IF;
END $$;

GRANT CONNECT ON DATABASE verder TO verder_app;
GRANT USAGE ON SCHEMA public TO verder_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO verder_app;

-- evidence tables: INSERT + SELECT only
GRANT SELECT, INSERT ON ledger_events, log_entries, parties, entry_participants,
  documents, entry_documents, action_items, document_status_changes,
  action_item_status_changes, raw_emails TO verder_app;

-- operational tables: no DELETE
GRANT SELECT, INSERT, UPDATE ON suggestions, worker_runs, users TO verder_app;
```

- [ ] **Step 2: Write failing integration tests**

`packages/api/package.json`:
```json
{
  "name": "@verder/api",
  "version": "0.0.1",
  "type": "module",
  "main": "./src/root.ts",
  "types": "./src/root.ts",
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit", "build": "tsc --noEmit" },
  "dependencies": {
    "@trpc/server": "^11.0.0", "zod": "^3.24.1",
    "@verder/core": "workspace:*", "@verder/db": "workspace:*", "drizzle-orm": "^0.38.0"
  },
  "devDependencies": { "vitest": "^2.1.8", "typescript": "^5.7.2", "pg": "^8.13.1", "@types/pg": "^8.11.10" }
}
```

`packages/api/src/ledger.test.ts`:
```ts
import { asc } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { verifyChain } from "@verder/core";
import { appendLedgerEvent } from "./ledger";

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://verder:verder@localhost:5432/verder";
const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("ledger + append-only enforcement", () => {
  let db: Db;
  beforeAll(() => { db = createDb(APP_URL).db; });

  it("appends chained events across transactions", async () => {
    const idA = crypto.randomUUID(); const idB = crypto.randomUUID();
    await db.transaction(async (tx) => {
      await appendLedgerEvent(tx, { eventType: "test.created", entityType: "test", entityId: idA, payload: { a: 1 } });
    });
    await db.transaction(async (tx) => {
      await appendLedgerEvent(tx, { eventType: "test.created", entityType: "test", entityId: idB, payload: { b: 2 } });
    });
    const events = await db.select().from(schema.ledgerEvents).orderBy(asc(schema.ledgerEvents.seq));
    const res = await verifyChain(events.map((e) => ({
      seq: e.seq, eventType: e.eventType, entityType: e.entityType,
      entityId: e.entityId, payloadHash: e.payloadHash, prevHash: e.prevHash, eventHash: e.eventHash,
    })));
    expect(res.ok).toBe(true);
  });

  it("app role cannot UPDATE or DELETE evidence rows", async () => {
    await expect(
      db.update(schema.ledgerEvents).set({ eventType: "hacked" })
    ).rejects.toThrow(/permission denied/);
    await expect(db.delete(schema.ledgerEvents)).rejects.toThrow(/permission denied/);
    await expect(db.delete(schema.logEntries)).rejects.toThrow(/permission denied/);
  });

  it("serializes concurrent appends without forking", async () => {
    await Promise.all(Array.from({ length: 8 }, (_, i) =>
      db.transaction(async (tx) =>
        appendLedgerEvent(tx, { eventType: "test.race", entityType: "test", entityId: crypto.randomUUID(), payload: { i } }))));
    const events = await db.select().from(schema.ledgerEvents).orderBy(asc(schema.ledgerEvents.seq));
    const seqs = events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    const res = await verifyChain(events.map((e) => ({
      seq: e.seq, eventType: e.eventType, entityType: e.entityType,
      entityId: e.entityId, payloadHash: e.payloadHash, prevHash: e.prevHash, eventHash: e.eventHash,
    })));
    expect(res.ok).toBe(true);
  });
});
```

Note for implementers: these ledger integration tests build on whatever chain already exists in the dev DB — they only assert the chain stays valid and seqs stay unique, never absolute seq values. ADMIN_URL is unused here but kept for parity with later test files that need admin-side setup.

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @verder/db migrate && pnpm --filter @verder/api test`
Expected: FAIL — `./ledger` not found.

- [ ] **Step 4: Implement appendLedgerEvent**

`packages/api/src/ledger.ts`:
```ts
import { desc, sql } from "drizzle-orm";
import { canonicalJson, computeEventHash, GENESIS_HASH, sha256Hex } from "@verder/core";
import { schema, type Db } from "@verder/db";

const LEDGER_LOCK_KEY = 42;

export interface AppendInput {
  eventType: string; entityType: string; entityId: string; payload: unknown;
}

// tx must be a transaction handle; caller inserts the entity in the SAME transaction.
export async function appendLedgerEvent(
  tx: Db, input: AppendInput
): Promise<{ seq: number; eventHash: string; payloadHash: string }> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${LEDGER_LOCK_KEY})`);
  const [head] = await tx.select().from(schema.ledgerEvents)
    .orderBy(desc(schema.ledgerEvents.seq)).limit(1);
  const seq = (head?.seq ?? 0) + 1;
  const prevHash = head?.eventHash ?? GENESIS_HASH;
  const payloadHash = sha256Hex(canonicalJson(input.payload));
  const eventHash = computeEventHash({
    seq, eventType: input.eventType, entityType: input.entityType,
    entityId: input.entityId, payloadHash, prevHash,
  });
  await tx.insert(schema.ledgerEvents).values({
    seq, eventType: input.eventType, entityType: input.entityType,
    entityId: input.entityId, payloadHash, prevHash, eventHash,
  });
  return { seq, eventHash, payloadHash };
}
```

`packages/api/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @verder/api test`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/db packages/api && git commit -m "feat: append-only grants and serialized ledger appends"
```

### Task 6: tRPC context + entries/parties routers

**Files:**
- Create: `packages/api/src/trpc.ts`, `packages/api/src/routers/parties.ts`, `packages/api/src/routers/entries.ts`, `packages/api/src/root.ts`
- Test: `packages/api/src/routers/entries.test.ts` (integration)

**Interfaces:**
- Consumes: `appendLedgerEvent` (Task 5), schema (Task 4).
- Produces:
  - `createContext({ db, userId }): Context` where `Context = { db: Db; userId: string | null }`.
  - `protectedProcedure` — throws `TRPCError({ code: "UNAUTHORIZED" })` when `userId` is null.
  - `appRouter` with `parties.create/list`, `entries.create/list/get/correct`. `type AppRouter = typeof appRouter`.
  - Ledger event types: `"entry.created"`, `"entry.corrected"`, `"party.created"`.
  - Entry ledger payload shape (this exact object is what gets hashed):
    `{ id, occurredAt: ISOstring, channel, direction, summary, details, source, sourceRef, supersedesId, participantPartyIds: sorted string[], documentIds: sorted string[], actionItems: [{description, ownerPartyId, dueAt, clarity}] sorted by description }`

- [ ] **Step 1: Write trpc plumbing**

`packages/api/src/trpc.ts`:
```ts
import { initTRPC, TRPCError } from "@trpc/server";
import type { Db } from "@verder/db";

export interface Context { db: Db; userId: string | null }
export function createContext(input: Context): Context { return input; }

const t = initTRPC.context<Context>().create();
export const router = t.router;
export const publicProcedure = t.procedure;
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.userId) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx: { ...ctx, userId: ctx.userId } });
});
```

`packages/api/src/routers/parties.ts`:
```ts
import { z } from "zod";
import { asc } from "drizzle-orm";
import { schema } from "@verder/db";
import { protectedProcedure, router } from "../trpc";
import { appendLedgerEvent } from "../ledger";

export const partiesRouter = router({
  list: protectedProcedure.query(({ ctx }) =>
    ctx.db.select().from(schema.parties).orderBy(asc(schema.parties.name))),
  create: protectedProcedure.input(z.object({
    kind: z.enum(["person", "organization"]),
    name: z.string().min(1),
    organization: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    notes: z.string().optional(),
  })).mutation(({ ctx, input }) =>
    ctx.db.transaction(async (tx) => {
      const [p] = await tx.insert(schema.parties).values(input).returning();
      await appendLedgerEvent(tx, {
        eventType: "party.created", entityType: "party", entityId: p.id,
        payload: { id: p.id, kind: p.kind, name: p.name, organization: p.organization,
          email: p.email, phone: p.phone, notes: p.notes },
      });
      return p;
    })),
});
```

- [ ] **Step 2: Write failing entries tests**

`packages/api/src/routers/entries.test.ts`:
```ts
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("entries router", () => {
  let db: Db; let userId: string;
  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `t${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));

  it("creates an entry with participants and action items in one transaction", async () => {
    const c = caller();
    const p = await c.parties.create({ kind: "organization", name: "VerderGroep" });
    const entry = await c.entries.create({
      occurredAt: new Date("2026-08-18T10:00:00Z"),
      channel: "call", direction: "inbound",
      summary: "Intake call about missing payslips",
      details: "They need payslips for June and July.",
      participantPartyIds: [p.id],
      actionItems: [{ description: "Send payslips June+July", clarity: "clear" }],
      documentIds: [],
    });
    expect(entry.id).toBeTruthy();
    const got = await c.entries.get({ id: entry.id });
    expect(got.participants.map((x) => x.partyId)).toEqual([p.id]);
    expect(got.actionItems).toHaveLength(1);
    expect(got.supersededBy).toBeNull();
  });

  it("correct() creates a new entry linked via supersedesId; original remains", async () => {
    const c = caller();
    const orig = await c.entries.create({
      occurredAt: new Date(), channel: "email", direction: "inbound",
      summary: "Wrong summary", participantPartyIds: [], actionItems: [], documentIds: [],
    });
    const fixed = await c.entries.correct({
      supersedesId: orig.id,
      occurredAt: new Date(), channel: "email", direction: "inbound",
      summary: "Right summary", participantPartyIds: [], actionItems: [], documentIds: [],
    });
    expect(fixed.supersedesId).toBe(orig.id);
    const both = await c.entries.get({ id: orig.id });
    expect(both.supersededBy).toBe(fixed.id);
  });

  it("rejects unauthenticated calls", async () => {
    const anon = appRouter.createCaller(createContext({ db, userId: null }));
    await expect(anon.entries.list({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @verder/api test entries`
Expected: FAIL — `../root` not found.

- [ ] **Step 4: Implement entries router + root**

`packages/api/src/routers/entries.ts`:
```ts
import { z } from "zod";
import { desc, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { protectedProcedure, router } from "../trpc";
import { appendLedgerEvent } from "../ledger";

const entryInput = z.object({
  occurredAt: z.coerce.date(),
  channel: z.enum(["call", "meeting", "email", "whatsapp", "voicemail", "letter", "other"]),
  direction: z.enum(["inbound", "outbound", "internal"]),
  summary: z.string().min(1),
  details: z.string().optional(),
  source: z.enum(["manual", "gmail-watch", "nas-watch"]).default("manual"),
  sourceRef: z.string().optional(),
  participantPartyIds: z.array(z.string().uuid()),
  documentIds: z.array(z.string().uuid()),
  actionItems: z.array(z.object({
    description: z.string().min(1),
    ownerPartyId: z.string().uuid().optional(),
    dueAt: z.coerce.date().optional(),
    clarity: z.enum(["clear", "ambiguous", "already-provided"]).default("clear"),
  })),
});

export type EntryInput = z.infer<typeof entryInput>;

export async function insertEntry(
  tx: Db, userId: string, input: EntryInput,
  opts: { eventType: "entry.created" | "entry.corrected"; supersedesId?: string }
) {
  const [entry] = await tx.insert(schema.logEntries).values({
    occurredAt: input.occurredAt, channel: input.channel, direction: input.direction,
    summary: input.summary, details: input.details, source: input.source,
    sourceRef: input.sourceRef, supersedesId: opts.supersedesId, createdBy: userId,
  }).returning();
  if (input.participantPartyIds.length)
    await tx.insert(schema.entryParticipants).values(
      input.participantPartyIds.map((partyId) => ({ entryId: entry.id, partyId })));
  if (input.documentIds.length)
    await tx.insert(schema.entryDocuments).values(
      input.documentIds.map((documentId) => ({ entryId: entry.id, documentId })));
  const items = [...input.actionItems].sort((a, b) => a.description.localeCompare(b.description));
  if (items.length)
    await tx.insert(schema.actionItems).values(
      items.map((a) => ({ entryId: entry.id, description: a.description,
        ownerPartyId: a.ownerPartyId, dueAt: a.dueAt, clarity: a.clarity })));
  await appendLedgerEvent(tx, {
    eventType: opts.eventType, entityType: "log_entry", entityId: entry.id,
    payload: {
      id: entry.id, occurredAt: input.occurredAt.toISOString(),
      channel: input.channel, direction: input.direction,
      summary: input.summary, details: input.details ?? null,
      source: input.source, sourceRef: input.sourceRef ?? null,
      supersedesId: opts.supersedesId ?? null,
      participantPartyIds: [...input.participantPartyIds].sort(),
      documentIds: [...input.documentIds].sort(),
      actionItems: items.map((a) => ({ description: a.description,
        ownerPartyId: a.ownerPartyId ?? null,
        dueAt: a.dueAt?.toISOString() ?? null, clarity: a.clarity })),
    },
  });
  return entry;
}

export const entriesRouter = router({
  create: protectedProcedure.input(entryInput).mutation(({ ctx, input }) =>
    ctx.db.transaction((tx) => insertEntry(tx, ctx.userId, input, { eventType: "entry.created" }))),

  correct: protectedProcedure
    .input(entryInput.extend({ supersedesId: z.string().uuid() }))
    .mutation(({ ctx, input }) =>
      ctx.db.transaction((tx) => insertEntry(tx, ctx.userId, input,
        { eventType: "entry.corrected", supersedesId: input.supersedesId }))),

  list: protectedProcedure.input(z.object({
    channel: z.enum(["call", "meeting", "email", "whatsapp", "voicemail", "letter", "other"]).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })).query(async ({ ctx, input }) => {
    const rows = await ctx.db.select().from(schema.logEntries)
      .where(input.channel ? eq(schema.logEntries.channel, input.channel) : undefined)
      .orderBy(desc(schema.logEntries.occurredAt)).limit(input.limit);
    return rows;
  }),

  get: protectedProcedure.input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [entry] = await ctx.db.select().from(schema.logEntries)
        .where(eq(schema.logEntries.id, input.id));
      if (!entry) throw new Error("Entry not found");
      const participants = await ctx.db.select().from(schema.entryParticipants)
        .where(eq(schema.entryParticipants.entryId, entry.id));
      const docs = await ctx.db.select().from(schema.entryDocuments)
        .where(eq(schema.entryDocuments.entryId, entry.id));
      const actionItems = await ctx.db.select().from(schema.actionItems)
        .where(eq(schema.actionItems.entryId, entry.id));
      const [successor] = await ctx.db.select().from(schema.logEntries)
        .where(eq(schema.logEntries.supersedesId, entry.id));
      return { ...entry, participants, documents: docs, actionItems,
        supersededBy: successor?.id ?? null };
    }),
});
```

`packages/api/src/root.ts`:
```ts
import { router } from "./trpc";
import { partiesRouter } from "./routers/parties";
import { entriesRouter } from "./routers/entries";

export const appRouter = router({
  parties: partiesRouter,
  entries: entriesRouter,
});
export type AppRouter = typeof appRouter;
export { createContext, type Context } from "./trpc";
```
(Later tasks add `documents`, `suggestions`, `verify` to this router object — each task shows its own one-line addition.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @verder/api test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/api && git commit -m "feat(api): entries and parties routers with ledger integration"
```

### Task 7: Content-addressed storage + documents router

**Files:**
- Create: `packages/api/src/storage.ts`, `packages/api/src/routers/documents.ts`
- Modify: `packages/api/src/root.ts` (add `documents: documentsRouter`)
- Test: `packages/api/src/storage.test.ts`, `packages/api/src/routers/documents.test.ts`

**Interfaces:**
- Consumes: `appendLedgerEvent`, schema, `sha256Hex`.
- Produces:
  - `storeFile(vaultDir: string, buf: Buffer): Promise<{ sha256: string; relPath: string }>` — writes to `<vaultDir>/<aa>/<bb>/<sha256>` (no extension; mime lives in DB), no-op if exists.
  - `readFilePath(vaultDir: string, sha256: string): string`
  - `ingestDocument(tx, input: { buf?: never; sha256: string; sizeBytes: number; mime: string; title: string; source: "upload"|"nas-scan"|"email-attachment"; sourceRef?: string; receivedAt: Date; docType?: string }): Promise<Document>` — inserts row + `"document.ingested"` ledger event whose payload is `{ id, sha256, title, docType, mime, sizeBytes, source, sourceRef, receivedAt: ISO }`. Returns existing document unchanged if sha256 already known (idempotent).
  - Router: `documents.registerUpload` (metadata after the HTTP upload route stored the file), `documents.list({status?})`, `documents.get`, `documents.file` (metadata + relPath), `documents.update` (insert into `document_status_changes` + `"document.updated"` ledger event), `documents.linkToEntry`.
  - Ledger event types: `"document.ingested"`, `"document.updated"`, `"document.linked"`.

- [ ] **Step 1: Write failing storage tests**

`packages/api/src/storage.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readFilePath, storeFile } from "./storage";

describe("content-addressed storage", () => {
  it("stores by sha256 with fan-out dirs and is idempotent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vault-"));
    const buf = Buffer.from("hello evidence");
    const a = await storeFile(dir, buf);
    const b = await storeFile(dir, buf);
    expect(a.sha256).toBe(b.sha256);
    expect(a.relPath).toBe(`${a.sha256.slice(0, 2)}/${a.sha256.slice(2, 4)}/${a.sha256}`);
    const back = await readFile(readFilePath(dir, a.sha256));
    expect(back.equals(buf)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement**

Run: `pnpm --filter @verder/api test storage` → FAIL.

`packages/api/src/storage.ts`:
```ts
import { mkdir, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256Hex } from "@verder/core";

export function relPathFor(sha256: string): string {
  return join(sha256.slice(0, 2), sha256.slice(2, 4), sha256);
}
export function readFilePath(vaultDir: string, sha256: string): string {
  return join(vaultDir, relPathFor(sha256));
}
export async function storeFile(vaultDir: string, buf: Buffer): Promise<{ sha256: string; relPath: string }> {
  const sha256 = sha256Hex(buf);
  const relPath = relPathFor(sha256);
  const abs = join(vaultDir, relPath);
  try { await access(abs); } catch {
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, buf, { flag: "wx" }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "EEXIST") throw e;
    });
  }
  return { sha256, relPath };
}
```

Run: `pnpm --filter @verder/api test storage` → PASS. Commit:
```bash
git add packages/api/src/storage.ts packages/api/src/storage.test.ts
git commit -m "feat(api): content-addressed file storage"
```

- [ ] **Step 3: Write failing documents router tests**

`packages/api/src/routers/documents.test.ts`:
```ts
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("documents router", () => {
  let db: Db; let userId: string;
  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `d${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));
  const sha = () => crypto.randomUUID().replaceAll("-", "").padEnd(64, "a");

  it("registers an upload idempotently", async () => {
    const c = caller();
    const input = { sha256: sha(), sizeBytes: 10, mime: "application/pdf",
      title: "Payslip June", source: "upload" as const, receivedAt: new Date() };
    const one = await c.documents.registerUpload(input);
    const two = await c.documents.registerUpload(input);
    expect(two.id).toBe(one.id);
    expect(one.status).toBe("inbox");
  });

  it("update() files a document via status-change row (original row untouched)", async () => {
    const c = caller();
    const doc = await c.documents.registerUpload({ sha256: sha(), sizeBytes: 5,
      mime: "image/png", title: "scan_001", source: "upload", receivedAt: new Date() });
    const updated = await c.documents.update({ id: doc.id, status: "filed",
      title: "Energy contract 2025", docType: "contract" });
    expect(updated.effectiveStatus).toBe("filed");
    expect(updated.effectiveTitle).toBe("Energy contract 2025");
    const [raw] = await db.select().from(schema.documents)
      .where((await import("drizzle-orm")).eq(schema.documents.id, doc.id));
    expect(raw.title).toBe("scan_001"); // evidence row never mutated
  });
});
```

- [ ] **Step 4: Run to verify failure, then implement**

Run: `pnpm --filter @verder/api test documents` → FAIL.

`packages/api/src/routers/documents.ts`:
```ts
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { protectedProcedure, router } from "../trpc";
import { appendLedgerEvent } from "../ledger";

export async function ingestDocument(tx: Db, input: {
  sha256: string; sizeBytes: number; mime: string; title: string;
  source: "upload" | "nas-scan" | "email-attachment"; sourceRef?: string;
  receivedAt: Date; docType?: string;
}) {
  const [existing] = await tx.select().from(schema.documents)
    .where(eq(schema.documents.sha256, input.sha256));
  if (existing) return existing;
  const [doc] = await tx.insert(schema.documents).values(input).returning();
  await appendLedgerEvent(tx, {
    eventType: "document.ingested", entityType: "document", entityId: doc.id,
    payload: { id: doc.id, sha256: doc.sha256, title: doc.title,
      docType: doc.docType ?? null, mime: doc.mime, sizeBytes: doc.sizeBytes,
      source: doc.source, sourceRef: doc.sourceRef ?? null,
      receivedAt: input.receivedAt.toISOString() },
  });
  return doc;
}

export async function effectiveDocument(db: Db, id: string) {
  const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, id));
  if (!doc) throw new Error("Document not found");
  const [latest] = await db.select().from(schema.documentStatusChanges)
    .where(eq(schema.documentStatusChanges.documentId, id))
    .orderBy(desc(schema.documentStatusChanges.createdAt)).limit(1);
  return { ...doc,
    effectiveStatus: latest?.status ?? doc.status,
    effectiveTitle: latest?.title ?? doc.title,
    effectiveDocType: latest?.docType ?? doc.docType };
}

export const documentsRouter = router({
  registerUpload: protectedProcedure.input(z.object({
    sha256: z.string().length(64), sizeBytes: z.number().int().positive(),
    mime: z.string(), title: z.string().min(1),
    source: z.enum(["upload", "nas-scan", "email-attachment"]),
    sourceRef: z.string().optional(), receivedAt: z.coerce.date(),
    docType: z.string().optional(),
  })).mutation(({ ctx, input }) =>
    ctx.db.transaction((tx) => ingestDocument(tx, input))),

  list: protectedProcedure.input(z.object({
    status: z.enum(["inbox", "filed"]).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })).query(async ({ ctx, input }) => {
    const rows = await ctx.db.select().from(schema.documents)
      .orderBy(desc(schema.documents.createdAt)).limit(input.limit);
    const effective = await Promise.all(rows.map((r) => effectiveDocument(ctx.db, r.id)));
    return input.status ? effective.filter((d) => d.effectiveStatus === input.status) : effective;
  }),

  get: protectedProcedure.input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) => effectiveDocument(ctx.db, input.id)),

  update: protectedProcedure.input(z.object({
    id: z.string().uuid(), status: z.enum(["inbox", "filed"]),
    title: z.string().optional(), docType: z.string().optional(),
  })).mutation(({ ctx, input }) =>
    ctx.db.transaction(async (tx) => {
      await tx.insert(schema.documentStatusChanges).values({
        documentId: input.id, status: input.status,
        title: input.title, docType: input.docType });
      await appendLedgerEvent(tx, {
        eventType: "document.updated", entityType: "document", entityId: input.id,
        payload: { id: input.id, status: input.status,
          title: input.title ?? null, docType: input.docType ?? null } });
      return effectiveDocument(tx, input.id);
    })),

  linkToEntry: protectedProcedure.input(z.object({
    documentId: z.string().uuid(), entryId: z.string().uuid(),
  })).mutation(({ ctx, input }) =>
    ctx.db.transaction(async (tx) => {
      await tx.insert(schema.entryDocuments)
        .values({ entryId: input.entryId, documentId: input.documentId });
      await appendLedgerEvent(tx, {
        eventType: "document.linked", entityType: "document", entityId: input.documentId,
        payload: { documentId: input.documentId, entryId: input.entryId } });
    })),
});
```

Add to `packages/api/src/root.ts` router object: `documents: documentsRouter,` (with import).

Run: `pnpm --filter @verder/api test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api && git commit -m "feat(api): documents router with idempotent ingest and status-change model"
```

### Task 8: Suggestions router (review queue + golden-rule dataset)

**Files:**
- Create: `packages/api/src/routers/suggestions.ts`
- Modify: `packages/api/src/root.ts` (add `suggestions: suggestionsRouter`)
- Test: `packages/api/src/routers/suggestions.test.ts`

**Interfaces:**
- Consumes: `insertEntry` (Task 6), `effectiveDocument` (Task 7), schema.
- Produces:
  - `suggestions.list({status})` — pending first, newest first; joins `rawEmails`/`documents` context.
  - `suggestions.approveEntry({ id, entry: EntryInput })` — in one transaction: `insertEntry(...)` with `source: "gmail-watch"`, then UPDATE suggestion row: status `approved` (if `entry` deep-equals `proposed`) or `edited`, `finalPayload = entry`, `resultEntryId`, `verdictAt = now`. Suggestion status flip is an operational update (allowed), the produced entry is evidence.
  - `suggestions.approveDocumentMeta({ id, title, docType })` — calls documents.update path + marks suggestion.
  - `suggestions.reject({ id, reason? })` — status `rejected`, `finalPayload = { reason }`.
  - Proposed payload shape for `kind: "log-entry"` (produced by worker in Task 17, consumed here and by the queue UI):
    `{ occurredAt: ISO, channel: "email", direction: "inbound"|"outbound", summary: string, details: string, participantNames: string[], actionItems: [{description, clarity}], attachmentDocumentIds: string[] }`

- [ ] **Step 1: Write failing tests**

`packages/api/src/routers/suggestions.test.ts`:
```ts
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("suggestions router", () => {
  let db: Db; let userId: string;
  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `s${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));

  async function makeSuggestion() {
    const [raw] = await db.insert(schema.rawEmails).values({
      gmailMessageId: `msg-${crypto.randomUUID()}`, gmailThreadId: "t1",
      fromAddr: "casemanager@verdergroep.nl", toAddr: "martin@vanderpoel.pro",
      subject: "Documents needed", sentAt: new Date(),
      rawRfc822Sha256: "a".repeat(64), bodyText: "Please send payslips.",
    }).returning();
    const [s] = await db.insert(schema.suggestions).values({
      kind: "log-entry", rawEmailId: raw.id, model: "qwen2.5:14b", promptVersion: "v1",
      proposed: { occurredAt: new Date().toISOString(), channel: "email", direction: "inbound",
        summary: "VerderGroep requests payslips", details: "June and July payslips requested.",
        participantNames: ["VerderGroep"], actionItems: [{ description: "Send payslips", clarity: "clear" }],
        attachmentDocumentIds: [] },
    }).returning();
    return s;
  }

  it("approveEntry creates a ledger-backed entry and marks status edited when changed", async () => {
    const s = await makeSuggestion();
    const c = caller();
    const res = await c.suggestions.approveEntry({
      id: s.id,
      entry: { occurredAt: new Date(), channel: "email", direction: "inbound",
        summary: "VerderGroep requests payslips June+July", // edited summary
        source: "gmail-watch", participantPartyIds: [], documentIds: [],
        actionItems: [{ description: "Send payslips", clarity: "clear" }] },
    });
    expect(res.entryId).toBeTruthy();
    const [after] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, s.id));
    expect(after.status).toBe("edited");
    expect(after.resultEntryId).toBe(res.entryId);
    expect(after.finalPayload).toBeTruthy();
  });

  it("reject stores verdict without touching the ledger", async () => {
    const s = await makeSuggestion();
    await caller().suggestions.reject({ id: s.id, reason: "Not relevant" });
    const [after] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.id, s.id));
    expect(after.status).toBe("rejected");
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement**

Run: `pnpm --filter @verder/api test suggestions` → FAIL.

`packages/api/src/routers/suggestions.ts`:
```ts
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { canonicalJson } from "@verder/core";
import { schema } from "@verder/db";
import { protectedProcedure, router } from "../trpc";
import { insertEntry } from "./entries";

const entryForApproval = z.object({
  occurredAt: z.coerce.date(),
  channel: z.enum(["call", "meeting", "email", "whatsapp", "voicemail", "letter", "other"]),
  direction: z.enum(["inbound", "outbound", "internal"]),
  summary: z.string().min(1),
  details: z.string().optional(),
  source: z.enum(["manual", "gmail-watch", "nas-watch"]),
  sourceRef: z.string().optional(),
  participantPartyIds: z.array(z.string().uuid()),
  documentIds: z.array(z.string().uuid()),
  actionItems: z.array(z.object({
    description: z.string().min(1),
    ownerPartyId: z.string().uuid().optional(),
    dueAt: z.coerce.date().optional(),
    clarity: z.enum(["clear", "ambiguous", "already-provided"]).default("clear"),
  })),
});

export const suggestionsRouter = router({
  list: protectedProcedure.input(z.object({
    status: z.enum(["pending", "approved", "edited", "rejected", "needs-manual"]).default("pending"),
  })).query(async ({ ctx, input }) => {
    const rows = await ctx.db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.status, input.status))
      .orderBy(desc(schema.suggestions.createdAt));
    return Promise.all(rows.map(async (s) => ({
      ...s,
      rawEmail: s.rawEmailId
        ? (await ctx.db.select().from(schema.rawEmails)
            .where(eq(schema.rawEmails.id, s.rawEmailId)))[0] ?? null
        : null,
    })));
  }),

  approveEntry: protectedProcedure.input(z.object({
    id: z.string().uuid(), entry: entryForApproval,
  })).mutation(({ ctx, input }) =>
    ctx.db.transaction(async (tx) => {
      const [s] = await tx.select().from(schema.suggestions)
        .where(eq(schema.suggestions.id, input.id));
      if (!s || (s.status !== "pending" && s.status !== "needs-manual"))
        throw new Error("Suggestion not open for review");
      const entry = await insertEntry(tx, ctx.userId, input.entry, { eventType: "entry.created" });
      const unchanged = s.proposed !== null &&
        canonicalJson(input.entry.summary) === canonicalJson((s.proposed as { summary?: string }).summary) &&
        (s.proposed as { details?: string }).details === (input.entry.details ?? undefined);
      await tx.update(schema.suggestions).set({
        status: unchanged ? "approved" : "edited",
        finalPayload: JSON.parse(JSON.stringify(input.entry)),
        resultEntryId: entry.id, verdictAt: new Date(),
      }).where(eq(schema.suggestions.id, input.id));
      return { entryId: entry.id };
    })),

  approveDocumentMeta: protectedProcedure.input(z.object({
    id: z.string().uuid(), title: z.string().min(1), docType: z.string().optional(),
  })).mutation(({ ctx, input }) =>
    ctx.db.transaction(async (tx) => {
      const [s] = await tx.select().from(schema.suggestions)
        .where(eq(schema.suggestions.id, input.id));
      if (!s?.documentId) throw new Error("Suggestion has no document");
      await tx.insert(schema.documentStatusChanges).values({
        documentId: s.documentId, status: "filed", title: input.title, docType: input.docType });
      const { appendLedgerEvent } = await import("../ledger");
      await appendLedgerEvent(tx, {
        eventType: "document.updated", entityType: "document", entityId: s.documentId,
        payload: { id: s.documentId, status: "filed", title: input.title, docType: input.docType ?? null } });
      await tx.update(schema.suggestions).set({
        status: "approved", finalPayload: { title: input.title, docType: input.docType ?? null },
        verdictAt: new Date(),
      }).where(eq(schema.suggestions.id, input.id));
    })),

  reject: protectedProcedure.input(z.object({
    id: z.string().uuid(), reason: z.string().optional(),
  })).mutation(({ ctx, input }) =>
    ctx.db.update(schema.suggestions).set({
      status: "rejected", finalPayload: { reason: input.reason ?? null }, verdictAt: new Date(),
    }).where(eq(schema.suggestions.id, input.id))),
});
```

Add to `root.ts`: `suggestions: suggestionsRouter,`.

Run: `pnpm --filter @verder/api test` → PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/api && git commit -m "feat(api): suggestions review queue with verdict tracking"
```

### Task 9: Verify + export router

**Files:**
- Create: `packages/api/src/routers/verify.ts`
- Modify: `packages/api/src/root.ts` (add `verify: verifyRouter`)
- Test: `packages/api/src/routers/verify.test.ts`

**Interfaces:**
- Consumes: `verifyChain` (Task 3), schema, `readFilePath` (Task 7).
- Produces:
  - `verify.run()` — loads all ledger events ordered by seq, runs `verifyChain` with a payload-recompute callback for `document.ingested` events (re-hash the stored file and compare to the `sha256` inside the entity row; the stored file's sha must equal `documents.sha256` for that entity). Returns `VerifyResult & { headHash: string | null; checkedFiles: number }`.
  - `verify.exportRange({ from: Date, to: Date })` — returns a structured export object the web PDF page renders: `{ generatedAt, from, to, headHash, entries: [{...entry, participants: partyName[], documents: [{title, sha256}], actionItems }] }`. (PDF rendering happens client-side in Task 14 via the browser's print-to-PDF on a print-styled page — no server PDF lib. YAGNI.)

- [ ] **Step 1: Write failing tests**

`packages/api/src/routers/verify.test.ts`:
```ts
import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createDb, schema, type Db } from "@verder/db";
import { sha256Hex } from "@verder/core";
import { appRouter } from "../root";
import { createContext } from "../trpc";
import { relPathFor } from "../storage";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

describe("verify router", () => {
  let db: Db; let userId: string; let vaultDir: string;
  beforeAll(async () => {
    db = createDb(APP_URL).db;
    vaultDir = mkdtempSync(join(tmpdir(), "vault-verify-"));
    process.env.VAULT_DIR = vaultDir;
    const [u] = await db.insert(schema.users)
      .values({ email: `v${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
  });
  const caller = () => appRouter.createCaller(createContext({ db, userId }));

  it("verifies the whole chain including document files", async () => {
    const c = caller();
    const buf = Buffer.from(`evidence-${Date.now()}`);
    const sha = sha256Hex(buf);
    const abs = join(vaultDir, relPathFor(sha));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, buf);
    await c.documents.registerUpload({ sha256: sha, sizeBytes: buf.length,
      mime: "text/plain", title: "Verify me", source: "upload", receivedAt: new Date() });
    const res = await c.verify.run();
    expect(res.ok).toBe(true);
    expect(res.headHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.checkedFiles).toBeGreaterThan(0);
  });

  it("exportRange returns entries with joined context", async () => {
    const c = caller();
    const p = await c.parties.create({ kind: "person", name: "Case Manager" });
    await c.entries.create({ occurredAt: new Date(), channel: "meeting",
      direction: "internal", summary: "Export test entry",
      participantPartyIds: [p.id], documentIds: [], actionItems: [] });
    const exp = await c.verify.exportRange({
      from: new Date(Date.now() - 86400000), to: new Date(Date.now() + 86400000) });
    expect(exp.headHash).toBeTruthy();
    expect(exp.entries.some((e) => e.summary === "Export test entry")).toBe(true);
    const found = exp.entries.find((e) => e.summary === "Export test entry");
    expect(found?.participants).toContain("Case Manager");
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement**

Run: `pnpm --filter @verder/api test verify` → FAIL.

`packages/api/src/routers/verify.ts`:
```ts
import { z } from "zod";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { sha256Hex, verifyChain, type ChainEvent } from "@verder/core";
import { schema } from "@verder/db";
import { protectedProcedure, router } from "../trpc";
import { readFilePath } from "../storage";

export const verifyRouter = router({
  run: protectedProcedure.mutation(async ({ ctx }) => {
    const vaultDir = process.env.VAULT_DIR ?? "./vault-files";
    const rows = await ctx.db.select().from(schema.ledgerEvents)
      .orderBy(asc(schema.ledgerEvents.seq));
    const events: ChainEvent[] = rows.map((e) => ({
      seq: e.seq, eventType: e.eventType, entityType: e.entityType,
      entityId: e.entityId, payloadHash: e.payloadHash,
      prevHash: e.prevHash, eventHash: e.eventHash }));
    let checkedFiles = 0;
    const res = await verifyChain(events, async (e) => {
      if (e.eventType !== "document.ingested") return e.payloadHash;
      const [doc] = await ctx.db.select().from(schema.documents)
        .where(eq(schema.documents.id, e.entityId));
      if (!doc) return "missing-document-row".padEnd(64, "0");
      try {
        const buf = await readFile(readFilePath(vaultDir, doc.sha256));
        checkedFiles++;
        return sha256Hex(buf) === doc.sha256 ? e.payloadHash : "file-hash-mismatch".padEnd(64, "0");
      } catch { return "file-missing".padEnd(64, "0"); }
    });
    return { ...res, headHash: rows.at(-1)?.eventHash ?? null, checkedFiles };
  }),

  exportRange: protectedProcedure.input(z.object({
    from: z.coerce.date(), to: z.coerce.date(),
  })).query(async ({ ctx, input }) => {
    const rows = await ctx.db.select().from(schema.logEntries)
      .where(and(gte(schema.logEntries.occurredAt, input.from),
                 lte(schema.logEntries.occurredAt, input.to)))
      .orderBy(asc(schema.logEntries.occurredAt));
    const [head] = await ctx.db.select().from(schema.ledgerEvents)
      .orderBy(asc(schema.ledgerEvents.seq));
    const last = await ctx.db.select().from(schema.ledgerEvents)
      .orderBy(asc(schema.ledgerEvents.seq));
    const entries = await Promise.all(rows.map(async (entry) => {
      const parts = await ctx.db
        .select({ name: schema.parties.name })
        .from(schema.entryParticipants)
        .innerJoin(schema.parties, eq(schema.entryParticipants.partyId, schema.parties.id))
        .where(eq(schema.entryParticipants.entryId, entry.id));
      const docs = await ctx.db
        .select({ title: schema.documents.title, sha256: schema.documents.sha256 })
        .from(schema.entryDocuments)
        .innerJoin(schema.documents, eq(schema.entryDocuments.documentId, schema.documents.id))
        .where(eq(schema.entryDocuments.entryId, entry.id));
      const items = await ctx.db.select().from(schema.actionItems)
        .where(eq(schema.actionItems.entryId, entry.id));
      return { ...entry, participants: parts.map((p) => p.name), documents: docs, actionItems: items };
    }));
    return { generatedAt: new Date().toISOString(), from: input.from.toISOString(),
      to: input.to.toISOString(), headHash: last.at(-1)?.eventHash ?? null, entries };
  }),
});
```
(Implementer note: the duplicate `head`/`last` selects above are a bug waiting to happen — keep only the `last` query and delete the unused `head`. Fetch it with `.orderBy(desc(...)).limit(1)` instead of loading all rows.)

Add to `root.ts`: `verify: verifyRouter,`.

Run: `pnpm --filter @verder/api test` → PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/api && git commit -m "feat(api): chain verification with file re-hashing and range export"
```

### Task 10: Auth package + Next.js app shell

**Note on visual design:** Tasks 10–14 build functional UI with Tailwind. The Figma-designed visual pass is a separate later cycle with Martin (per spec's design workflow) — do not attempt visual polish here, but keep markup semantic so restyling is cheap. UI copy follows the tone rule: supportive, encouraging, never clinical ("Nice — 3 items waiting for your review" not "3 unprocessed items").

**Files:**
- Create: `packages/auth/package.json`, `packages/auth/tsconfig.json`, `packages/auth/src/index.ts`, `packages/auth/src/seed.ts`
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/next.config.ts`, `apps/web/postcss.config.mjs`, `apps/web/src/app/globals.css`, `apps/web/src/app/layout.tsx`, `apps/web/src/lib/trpc-server.ts`, `apps/web/src/lib/trpc-client.tsx`, `apps/web/src/app/api/trpc/[trpc]/route.ts`, `apps/web/src/app/api/auth/[...all]/route.ts`, `apps/web/src/app/api/files/[sha256]/route.ts`, `apps/web/src/app/api/upload/route.ts`, `apps/web/src/app/(auth)/login/page.tsx`, `apps/web/src/middleware.ts`
- Test: `packages/auth/src/index.test.ts`

**Interfaces:**
- Consumes: `appRouter`, `createContext` (Tasks 6–9), `createDb`, `storeFile`.
- Produces:
  - `createAuth(opts: { db: Db; secret: string; baseURL: string }): ReturnType<typeof betterAuth>` — email+password, single user, session cookies. better-auth manages its own tables (run `npx @better-auth/cli migrate` as admin role).
  - `pnpm --filter @verder/auth seed` — creates Martin's user (email `martin@vanderpoel.pro`, password from `SEED_PASSWORD` env) in better-auth AND inserts matching row in our `users` table; prints the user id.
  - Web helpers: `serverCaller(): Promise<ReturnType<typeof appRouter.createCaller>>` (reads session from cookies, builds context); `TRPCProvider` + `trpc` client hooks for client components.
  - `POST /api/upload` (multipart): stores file via `storeFile(VAULT_DIR, buf)`, calls `documents.registerUpload`, returns the document JSON.
  - `GET /api/files/[sha256]`: streams the vault file with stored mime (auth-gated).
  - `middleware.ts`: redirects unauthenticated requests (except `/login`, `/api/auth`) to `/login`.

- [ ] **Step 1: Auth package + failing test**

`packages/auth/package.json`:
```json
{
  "name": "@verder/auth",
  "version": "0.0.1",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit", "build": "tsc --noEmit",
    "seed": "node --experimental-strip-types src/seed.ts" },
  "dependencies": { "better-auth": "^1.1.0", "@verder/db": "workspace:*", "drizzle-orm": "^0.38.0" },
  "devDependencies": { "vitest": "^2.1.8", "typescript": "^5.7.2" }
}
```

`packages/auth/src/index.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createAuth } from "./index";
import { createDb } from "@verder/db";

describe("auth", () => {
  it("builds a better-auth instance with email/password enabled", () => {
    const { db } = createDb(process.env.DATABASE_URL ?? "postgres://verder:verder@localhost:5432/verder");
    const auth = createAuth({ db, secret: "test-secret", baseURL: "http://localhost:3000" });
    expect(auth.handler).toBeTypeOf("function");
    expect(auth.api.signInEmail).toBeTypeOf("function");
  });
});
```

Run: `pnpm --filter @verder/auth test` → FAIL. Then implement:

`packages/auth/src/index.ts`:
```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Db } from "@verder/db";

export function createAuth(opts: { db: Db; secret: string; baseURL: string }) {
  return betterAuth({
    database: drizzleAdapter(opts.db, { provider: "pg" }),
    secret: opts.secret,
    baseURL: opts.baseURL,
    emailAndPassword: { enabled: true },
    // Single-user v1: sign-ups are disabled after seeding via env flag.
    ...(process.env.ALLOW_SIGNUP === "1" ? {} : { disabledPaths: ["/sign-up/email"] }),
  });
}
```

`packages/auth/src/seed.ts`:
```ts
import { createDb, schema } from "@verder/db";
import { eq } from "drizzle-orm";
import { createAuth } from "./index";

const email = process.env.SEED_EMAIL ?? "martin@vanderpoel.pro";
const password = process.env.SEED_PASSWORD;
if (!password) { console.error("Set SEED_PASSWORD"); process.exit(1); }

const { db, pool } = createDb(process.env.DATABASE_URL!);
process.env.ALLOW_SIGNUP = "1";
const auth = createAuth({ db, secret: process.env.AUTH_SECRET!, baseURL: process.env.APP_URL ?? "http://localhost:3000" });
await auth.api.signUpEmail({ body: { email, password, name: "Martin van der Poel" } });
const existing = await db.select().from(schema.users).where(eq(schema.users.email, email));
if (existing.length === 0)
  await db.insert(schema.users).values({ email, name: "Martin van der Poel" });
const [u] = await db.select().from(schema.users).where(eq(schema.users.email, email));
console.log(`Seeded user ${u.id} (${email})`);
await pool.end();
```

Run `npx @better-auth/cli migrate` (with admin DATABASE_URL) then `pnpm --filter @verder/auth test` → PASS. Grant the app role access to better-auth's tables (add to a new migration `0003_auth_grants.sql`): `GRANT SELECT, INSERT, UPDATE ON "user", "session", "account", "verification" TO verder_app;`

Commit: `git add packages/auth packages/db && git commit -m "feat(auth): better-auth email/password with seed script"`

- [ ] **Step 2: Next.js app scaffold**

`apps/web/package.json`:
```json
{
  "name": "web",
  "private": true,
  "scripts": { "dev": "next dev", "build": "next build", "start": "next start", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "next": "^15.1.0", "react": "^19.0.0", "react-dom": "^19.0.0",
    "@trpc/client": "^11.0.0", "@trpc/server": "^11.0.0", "@trpc/react-query": "^11.0.0",
    "@tanstack/react-query": "^5.62.0", "superjson": "^2.2.2",
    "@verder/api": "workspace:*", "@verder/auth": "workspace:*", "@verder/db": "workspace:*",
    "better-auth": "^1.1.0", "drizzle-orm": "^0.38.0", "zod": "^3.24.1"
  },
  "devDependencies": { "typescript": "^5.7.2", "@types/react": "^19.0.0", "@types/node": "^22.10.0",
    "tailwindcss": "^4.0.0", "@tailwindcss/postcss": "^4.0.0" }
}
```

Note: tRPC v11 transformer — pass `transformer: superjson` in both the client `httpBatchLink` and the server `fetchRequestHandler` is NOT needed; superjson is configured once in `initTRPC.create({ transformer: superjson })`. Go back to `packages/api/src/trpc.ts` and change the create call to `initTRPC.context<Context>().create({ transformer: superjson })`, add `superjson` to `@verder/api` deps, and add `transformer: superjson` to the web client links config. Dates then survive the wire (the routers above rely on this).

`apps/web/src/lib/trpc-server.ts`:
```ts
import { cache } from "react";
import { headers } from "next/headers";
import { appRouter, createContext } from "@verder/api";
import { createDb } from "@verder/db";
import { getAuth } from "./auth";

const dbSingleton = cache(() => createDb(process.env.DATABASE_URL!));

export const serverCaller = cache(async () => {
  const { db } = dbSingleton();
  const session = await getAuth().api.getSession({ headers: await headers() });
  const userId = session ? await appUserId(session.user.email) : null;
  return appRouter.createCaller(createContext({ db, userId }));
});

async function appUserId(email: string): Promise<string | null> {
  const { db } = dbSingleton();
  const { schema } = await import("@verder/db");
  const { eq } = await import("drizzle-orm");
  const [u] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  return u?.id ?? null;
}
```

`apps/web/src/lib/auth.ts`:
```ts
import { cache } from "react";
import { createAuth } from "@verder/auth";
import { createDb } from "@verder/db";

export const getAuth = cache(() =>
  createAuth({ db: createDb(process.env.DATABASE_URL!).db,
    secret: process.env.AUTH_SECRET!, baseURL: process.env.APP_URL! }));
```

`apps/web/src/app/api/auth/[...all]/route.ts`:
```ts
import { getAuth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";
export const { GET, POST } = toNextJsHandler(getAuth());
```

`apps/web/src/app/api/trpc/[trpc]/route.ts`:
```ts
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter, createContext } from "@verder/api";
import { createDb } from "@verder/db";
import { getAuth } from "@/lib/auth";
import { schema } from "@verder/db";
import { eq } from "drizzle-orm";

const { db } = createDb(process.env.DATABASE_URL!);

const handler = async (req: Request) => {
  const session = await getAuth().api.getSession({ headers: req.headers });
  let userId: string | null = null;
  if (session) {
    const [u] = await db.select().from(schema.users)
      .where(eq(schema.users.email, session.user.email));
    userId = u?.id ?? null;
  }
  return fetchRequestHandler({ endpoint: "/api/trpc", req, router: appRouter,
    createContext: () => createContext({ db, userId }) });
};
export { handler as GET, handler as POST };
```

`apps/web/src/lib/trpc-client.tsx`:
```tsx
"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCReact } from "@trpc/react-query";
import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { useState, type ReactNode } from "react";
import type { AppRouter } from "@verder/api";

export const trpc = createTRPCReact<AppRouter>();

export function TRPCProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const [client] = useState(() => trpc.createClient({
    links: [httpBatchLink({ url: "/api/trpc", transformer: superjson })] }));
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
```

`apps/web/src/app/layout.tsx`:
```tsx
import "./globals.css";
import Link from "next/link";
import { TRPCProvider } from "@/lib/trpc-client";

export const metadata = { title: "verder — jouw dossier, jouw bewijs" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900">
        <TRPCProvider>
          <div className="flex">
            <nav className="w-56 min-h-screen border-r bg-white p-4 space-y-2">
              <p className="font-bold text-lg mb-4">verder</p>
              {[["Dashboard", "/dashboard"], ["Logbook", "/logbook"], ["Vault", "/vault"],
                ["Review queue", "/queue"], ["Verify", "/verify"]].map(([label, href]) => (
                <Link key={href} href={href} className="block rounded px-3 py-2 hover:bg-slate-100">{label}</Link>
              ))}
            </nav>
            <main className="flex-1 p-8">{children}</main>
          </div>
        </TRPCProvider>
      </body>
    </html>
  );
}
```

`apps/web/src/app/(auth)/login/page.tsx`:
```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createAuthClient } from "better-auth/react";

const authClient = createAuthClient();

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="max-w-sm mx-auto mt-24 space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const res = await authClient.signIn.email({ email, password });
        if (res.error) setError("That didn't work — check your email and password and try again.");
        else router.push("/dashboard");
      }}>
      <h1 className="text-2xl font-bold">Welcome back 👋</h1>
      <input className="w-full border rounded p-2" type="email" placeholder="Email"
        value={email} onChange={(e) => setEmail(e.target.value)} />
      <input className="w-full border rounded p-2" type="password" placeholder="Password"
        value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && <p className="text-red-600 text-sm">{error}</p>}
      <button className="w-full rounded bg-slate-900 text-white p-2">Sign in</button>
    </form>
  );
}
```

`apps/web/src/middleware.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";

export function middleware(req: NextRequest) {
  const isPublic = req.nextUrl.pathname.startsWith("/login")
    || req.nextUrl.pathname.startsWith("/api/auth");
  const hasSession = req.cookies.has("better-auth.session_token");
  if (!isPublic && !hasSession)
    return NextResponse.redirect(new URL("/login", req.url));
  return NextResponse.next();
}
export const config = { matcher: ["/((?!_next|favicon).*)"] };
```
(Cookie presence is a fast-path redirect only; real enforcement stays in `protectedProcedure` and the route handlers, which validate the session server-side.)

`apps/web/src/app/api/upload/route.ts`:
```ts
import { NextResponse } from "next/server";
import { storeFile } from "@verder/api/src/storage";
import { serverCaller } from "@/lib/trpc-server";

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "file required" }, { status: 400 });
  const buf = Buffer.from(await file.arrayBuffer());
  const { sha256 } = await storeFile(process.env.VAULT_DIR ?? "./vault-files", buf);
  const caller = await serverCaller();
  const doc = await caller.documents.registerUpload({
    sha256, sizeBytes: buf.length, mime: file.type || "application/octet-stream",
    title: file.name, source: "upload", receivedAt: new Date() });
  return NextResponse.json(doc);
}
```

`apps/web/src/app/api/files/[sha256]/route.ts`:
```ts
import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { readFilePath } from "@verder/api/src/storage";
import { serverCaller } from "@/lib/trpc-server";

export async function GET(_req: Request, { params }: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await params;
  const caller = await serverCaller(); // throws/401s if unauthenticated
  const docs = await caller.documents.list({ limit: 200 });
  const doc = docs.find((d) => d.sha256 === sha256);
  if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 });
  const buf = await readFile(readFilePath(process.env.VAULT_DIR ?? "./vault-files", sha256));
  return new NextResponse(buf, { headers: { "Content-Type": doc.mime } });
}
```
(Implementer: add a `documents.bySha` query to the documents router instead of `list().find()` — same pattern as `get` but keyed on `eq(schema.documents.sha256, input.sha256)` — and use it here.)

- [ ] **Step 3: Verify manually**

Run: `SEED_PASSWORD=devpass pnpm --filter @verder/auth seed && pnpm --filter web dev`
Expected: `/login` renders; signing in with the seeded credentials lands on `/dashboard` (404 for now is fine — page comes in Task 13); unauthenticated `/logbook` redirects to `/login`.

- [ ] **Step 4: Commit**

```bash
git add apps/web packages/auth packages/api && git commit -m "feat(web): Next.js shell with auth, trpc wiring, upload and file routes"
```

### Task 11: Logbook pages (timeline, detail, new/correct form)

**Files:**
- Create: `apps/web/src/app/logbook/page.tsx`, `apps/web/src/app/logbook/[id]/page.tsx`, `apps/web/src/app/logbook/new/page.tsx`, `apps/web/src/components/entry-form.tsx`

**Interfaces:**
- Consumes: `entries.*`, `parties.*` via `trpc` client hooks (Task 10); `serverCaller` for server components.
- Produces: `/logbook`, `/logbook/[id]`, `/logbook/new`, `/logbook/new?correct=<entryId>` (correction mode pre-fills from the original and calls `entries.correct`).

- [ ] **Step 1: Timeline page (server component)**

`apps/web/src/app/logbook/page.tsx`:
```tsx
import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";

export default async function LogbookPage() {
  const caller = await serverCaller();
  const entries = await caller.entries.list({ limit: 100 });
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Logbook</h1>
        <Link href="/logbook/new" className="rounded bg-slate-900 text-white px-4 py-2">+ Log a contact moment</Link>
      </div>
      {entries.length === 0 && <p>Nothing logged yet — your first entry is one click away. 💪</p>}
      <ul className="space-y-3">
        {entries.map((e) => (
          <li key={e.id} className="rounded border bg-white p-4">
            <Link href={`/logbook/${e.id}`} className="font-medium hover:underline">{e.summary}</Link>
            <p className="text-sm text-slate-500">
              {e.channel} · {e.direction} · {new Date(e.occurredAt).toLocaleString("nl-NL")}
              {e.supersedesId && " · correction"}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Detail page**

`apps/web/src/app/logbook/[id]/page.tsx`:
```tsx
import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";

export default async function EntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await serverCaller();
  const e = await caller.entries.get({ id });
  const parties = await caller.parties.list();
  const nameOf = (pid: string) => parties.find((p) => p.id === pid)?.name ?? pid;
  return (
    <article className="max-w-2xl space-y-4">
      {e.supersededBy && (
        <p className="rounded bg-amber-50 border border-amber-300 p-3 text-sm">
          This entry was corrected — see <Link className="underline" href={`/logbook/${e.supersededBy}`}>the correction</Link>. Both stay on record; that's what makes your log credible.
        </p>
      )}
      <h1 className="text-2xl font-bold">{e.summary}</h1>
      <p className="text-sm text-slate-500">
        {e.channel} · {e.direction} · happened {new Date(e.occurredAt).toLocaleString("nl-NL")} · logged {new Date(e.recordedAt).toLocaleString("nl-NL")} · source: {e.source}
      </p>
      {e.details && <p className="whitespace-pre-wrap">{e.details}</p>}
      <section>
        <h2 className="font-semibold">Who was involved</h2>
        <ul className="list-disc ml-5">{e.participants.map((p) => <li key={p.partyId}>{nameOf(p.partyId)}</li>)}</ul>
      </section>
      <section>
        <h2 className="font-semibold">Agreed actions</h2>
        <ul className="list-disc ml-5">
          {e.actionItems.map((a) => (
            <li key={a.id}>{a.description} <span className="text-xs text-slate-500">({a.clarity}{a.dueAt ? `, due ${new Date(a.dueAt).toLocaleDateString("nl-NL")}` : ""})</span></li>
          ))}
        </ul>
      </section>
      {!e.supersededBy && (
        <Link href={`/logbook/new?correct=${e.id}`} className="inline-block rounded border px-4 py-2">Correct this entry</Link>
      )}
    </article>
  );
}
```

- [ ] **Step 3: Entry form (client component, used for new + correct)**

`apps/web/src/components/entry-form.tsx`:
```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";

const CHANNELS = ["call", "meeting", "email", "whatsapp", "voicemail", "letter", "other"] as const;

export function EntryForm({ correctId }: { correctId?: string }) {
  const router = useRouter();
  const parties = trpc.parties.list.useQuery();
  const original = trpc.entries.get.useQuery({ id: correctId! }, { enabled: !!correctId });
  const createParty = trpc.parties.create.useMutation({ onSuccess: () => parties.refetch() });
  const create = trpc.entries.create.useMutation({ onSuccess: (e) => router.push(`/logbook/${e.id}`) });
  const correct = trpc.entries.correct.useMutation({ onSuccess: (e) => router.push(`/logbook/${e.id}`) });

  const [form, setForm] = useState({
    occurredAt: new Date().toISOString().slice(0, 16),
    channel: "call" as (typeof CHANNELS)[number],
    direction: "inbound" as "inbound" | "outbound" | "internal",
    summary: "", details: "", participantPartyIds: [] as string[],
    actionItems: [] as { description: string; clarity: "clear" | "ambiguous" | "already-provided" }[],
  });
  const [newParty, setNewParty] = useState("");

  // Pre-fill once when correcting
  if (correctId && original.data && form.summary === "" && original.data.summary !== "") {
    setForm((f) => ({ ...f, summary: original.data.summary, details: original.data.details ?? "",
      channel: original.data.channel, direction: original.data.direction,
      occurredAt: new Date(original.data.occurredAt).toISOString().slice(0, 16),
      participantPartyIds: original.data.participants.map((p) => p.partyId) }));
  }

  const submit = () => {
    const payload = { ...form, occurredAt: new Date(form.occurredAt),
      details: form.details || undefined, documentIds: [], source: "manual" as const };
    if (correctId) correct.mutate({ ...payload, supersedesId: correctId });
    else create.mutate(payload);
  };

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-bold">{correctId ? "Correct an entry" : "Log a contact moment"}</h1>
      {correctId && <p className="text-sm text-slate-600">The original stays on record; this saves a linked correction.</p>}
      <div className="grid grid-cols-3 gap-3">
        <label className="block">When<input type="datetime-local" className="w-full border rounded p-2"
          value={form.occurredAt} onChange={(e) => setForm({ ...form, occurredAt: e.target.value })} /></label>
        <label className="block">Channel<select className="w-full border rounded p-2" value={form.channel}
          onChange={(e) => setForm({ ...form, channel: e.target.value as typeof form.channel })}>
          {CHANNELS.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label className="block">Direction<select className="w-full border rounded p-2" value={form.direction}
          onChange={(e) => setForm({ ...form, direction: e.target.value as typeof form.direction })}>
          <option>inbound</option><option>outbound</option><option>internal</option></select></label>
      </div>
      <label className="block">What happened (short)<input className="w-full border rounded p-2"
        value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} /></label>
      <label className="block">Details<textarea className="w-full border rounded p-2" rows={5}
        value={form.details} onChange={(e) => setForm({ ...form, details: e.target.value })} /></label>
      <fieldset>
        <legend className="font-semibold">Who was involved</legend>
        {parties.data?.map((p) => (
          <label key={p.id} className="mr-4"><input type="checkbox"
            checked={form.participantPartyIds.includes(p.id)}
            onChange={(e) => setForm({ ...form, participantPartyIds: e.target.checked
              ? [...form.participantPartyIds, p.id]
              : form.participantPartyIds.filter((x) => x !== p.id) })} /> {p.name}</label>
        ))}
        <div className="flex gap-2 mt-2">
          <input className="border rounded p-2 flex-1" placeholder="Add a person or organization"
            value={newParty} onChange={(e) => setNewParty(e.target.value)} />
          <button type="button" className="rounded border px-3"
            onClick={() => { if (newParty) { createParty.mutate({ kind: "person", name: newParty }); setNewParty(""); } }}>Add</button>
        </div>
      </fieldset>
      <fieldset>
        <legend className="font-semibold">Agreed actions</legend>
        {form.actionItems.map((a, i) => (
          <div key={i} className="flex gap-2 mb-2">
            <input className="border rounded p-2 flex-1" value={a.description}
              onChange={(e) => setForm({ ...form, actionItems: form.actionItems.map((x, j) => j === i ? { ...x, description: e.target.value } : x) })} />
            <select className="border rounded p-2" value={a.clarity}
              onChange={(e) => setForm({ ...form, actionItems: form.actionItems.map((x, j) => j === i ? { ...x, clarity: e.target.value as typeof a.clarity } : x) })}>
              <option>clear</option><option>ambiguous</option><option>already-provided</option></select>
          </div>
        ))}
        <button type="button" className="rounded border px-3 py-1"
          onClick={() => setForm({ ...form, actionItems: [...form.actionItems, { description: "", clarity: "clear" }] })}>+ action</button>
      </fieldset>
      <button className="rounded bg-slate-900 text-white px-6 py-2 disabled:opacity-50"
        disabled={!form.summary || create.isPending || correct.isPending} onClick={submit}>
        {correctId ? "Save correction" : "Save to the record"}
      </button>
    </div>
  );
}
```

`apps/web/src/app/logbook/new/page.tsx`:
```tsx
import { EntryForm } from "@/components/entry-form";

export default async function NewEntryPage({ searchParams }: { searchParams: Promise<{ correct?: string }> }) {
  const { correct } = await searchParams;
  return <EntryForm correctId={correct} />;
}
```

- [ ] **Step 4: Verify manually**

Run: `pnpm --filter web dev`. Create a party + entry with an action item; open detail; correct it; confirm original shows the amber "corrected" banner and both entries exist in `/logbook`.

- [ ] **Step 5: Commit**

```bash
git add apps/web && git commit -m "feat(web): logbook timeline, detail, and entry/correction form"
```

### Task 12: Vault pages (inbox, library, document detail)

**Files:**
- Create: `apps/web/src/app/vault/page.tsx`, `apps/web/src/app/vault/[id]/page.tsx`, `apps/web/src/components/upload-drop.tsx`

**Interfaces:**
- Consumes: `documents.*` hooks; `POST /api/upload`; `GET /api/files/[sha256]`.
- Produces: `/vault` (inbox section + filed library), `/vault/[id]` (preview, metadata edit → `documents.update`, link to entry via `documents.linkToEntry`).

- [ ] **Step 1: Vault list + upload**

`apps/web/src/components/upload-drop.tsx`:
```tsx
"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function UploadDrop() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    for (const file of Array.from(files)) {
      const fd = new FormData(); fd.append("file", file);
      await fetch("/api/upload", { method: "POST", body: fd });
    }
    setBusy(false); router.refresh();
  };
  return (
    <label className="block rounded border-2 border-dashed p-8 text-center cursor-pointer bg-white"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); void upload(e.dataTransfer.files); }}>
      {busy ? "Storing safely…" : "Drop files here or click to add them to your vault"}
      <input type="file" multiple className="hidden" onChange={(e) => void upload(e.target.files)} />
    </label>
  );
}
```

`apps/web/src/app/vault/page.tsx`:
```tsx
import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";
import { UploadDrop } from "@/components/upload-drop";

export default async function VaultPage() {
  const caller = await serverCaller();
  const inbox = await caller.documents.list({ status: "inbox", limit: 100 });
  const filed = await caller.documents.list({ status: "filed", limit: 100 });
  const Row = ({ d }: { d: (typeof inbox)[number] }) => (
    <li className="rounded border bg-white p-3 flex justify-between">
      <Link href={`/vault/${d.id}`} className="hover:underline">{d.effectiveTitle}</Link>
      <span className="text-xs text-slate-500">{d.effectiveDocType ?? d.mime} · {(d.sizeBytes / 1024).toFixed(0)} KB · {d.source}</span>
    </li>
  );
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Vault</h1>
      <UploadDrop />
      <section>
        <h2 className="font-semibold mb-2">Inbox — {inbox.length ? `${inbox.length} to sort, no rush` : "all sorted, nice work ✨"}</h2>
        <ul className="space-y-2">{inbox.map((d) => <Row key={d.id} d={d} />)}</ul>
      </section>
      <section>
        <h2 className="font-semibold mb-2">Filed documents</h2>
        <ul className="space-y-2">{filed.map((d) => <Row key={d.id} d={d} />)}</ul>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Document detail**

`apps/web/src/app/vault/[id]/page.tsx`:
```tsx
import { serverCaller } from "@/lib/trpc-server";
import { DocumentMetaForm } from "@/components/document-meta-form";

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await serverCaller();
  const d = await caller.documents.get({ id });
  const entries = await caller.entries.list({ limit: 100 });
  return (
    <div className="grid grid-cols-2 gap-8">
      <div>
        <h1 className="text-xl font-bold mb-1">{d.effectiveTitle}</h1>
        <p className="text-xs text-slate-500 mb-4 break-all">sha256: {d.sha256}</p>
        {d.mime.startsWith("image/")
          ? <img src={`/api/files/${d.sha256}`} alt={d.effectiveTitle} className="max-w-full border rounded" />
          : <iframe src={`/api/files/${d.sha256}`} className="w-full h-[70vh] border rounded" title={d.effectiveTitle} />}
      </div>
      <DocumentMetaForm doc={{ id: d.id, title: d.effectiveTitle, docType: d.effectiveDocType,
        status: d.effectiveStatus }} entries={entries.map((e) => ({ id: e.id, summary: e.summary }))} />
    </div>
  );
}
```

`apps/web/src/components/document-meta-form.tsx`:
```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";

export function DocumentMetaForm({ doc, entries }: {
  doc: { id: string; title: string; docType: string | null; status: "inbox" | "filed" };
  entries: { id: string; summary: string }[];
}) {
  const router = useRouter();
  const [title, setTitle] = useState(doc.title);
  const [docType, setDocType] = useState(doc.docType ?? "");
  const [entryId, setEntryId] = useState("");
  const update = trpc.documents.update.useMutation({ onSuccess: () => router.refresh() });
  const link = trpc.documents.linkToEntry.useMutation({ onSuccess: () => router.refresh() });
  return (
    <div className="space-y-4">
      <label className="block">Title<input className="w-full border rounded p-2" value={title}
        onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="block">Type<input className="w-full border rounded p-2" placeholder="contract, payslip, letter…"
        value={docType} onChange={(e) => setDocType(e.target.value)} /></label>
      <button className="rounded bg-slate-900 text-white px-4 py-2"
        onClick={() => update.mutate({ id: doc.id, status: "filed", title, docType: docType || undefined })}>
        {doc.status === "inbox" ? "File it ✔" : "Save changes"}
      </button>
      <div className="pt-4 border-t">
        <label className="block">Link to a logbook entry
          <select className="w-full border rounded p-2" value={entryId} onChange={(e) => setEntryId(e.target.value)}>
            <option value="">— pick an entry —</option>
            {entries.map((e) => <option key={e.id} value={e.id}>{e.summary}</option>)}
          </select></label>
        <button className="mt-2 rounded border px-4 py-2" disabled={!entryId}
          onClick={() => link.mutate({ documentId: doc.id, entryId })}>Link</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify manually**

Upload a PDF and an image via `/vault`; both appear in Inbox; open one, retitle + "File it"; confirm it moves to Filed and the preview renders from `/api/files/<sha>`.

- [ ] **Step 4: Commit**

```bash
git add apps/web && git commit -m "feat(web): vault inbox, library, upload, and document detail"
```

### Task 13: Review queue + dashboard

**Files:**
- Create: `apps/web/src/app/queue/page.tsx`, `apps/web/src/components/suggestion-card.tsx`, `apps/web/src/app/dashboard/page.tsx`

**Interfaces:**
- Consumes: `suggestions.*`, `entries.list`, `documents.list`, plus a new `dashboard.stats` — add to `packages/api` a tiny router: `stats: protectedProcedure.query` returning `{ pendingSuggestions: number; inboxDocs: number; openActionItems: number; lastWorkerRuns: { worker: string; status: string; ranAt: Date }[] }` (counts via `count()` on suggestions where status='pending', documents effective status inbox, action items without a 'done'/'cancelled' status-change row; latest `worker_runs` row per worker via `DISTINCT ON`). Register as `dashboard: dashboardRouter` in root.
- Produces: `/queue`, `/dashboard`.

- [ ] **Step 1: Add `dashboardRouter` to the api**

`packages/api/src/routers/dashboard.ts`:
```ts
import { sql } from "drizzle-orm";
import { protectedProcedure, router } from "../trpc";

export const dashboardRouter = router({
  stats: protectedProcedure.query(async ({ ctx }) => {
    const [{ pending }] = (await ctx.db.execute(
      sql`SELECT count(*)::int AS pending FROM suggestions WHERE status IN ('pending','needs-manual')`)).rows as [{ pending: number }];
    const [{ inbox }] = (await ctx.db.execute(sql`
      SELECT count(*)::int AS inbox FROM documents d
      WHERE COALESCE((SELECT c.status FROM document_status_changes c
        WHERE c.document_id = d.id ORDER BY c.created_at DESC LIMIT 1), d.status) = 'inbox'`)).rows as [{ inbox: number }];
    const [{ open }] = (await ctx.db.execute(sql`
      SELECT count(*)::int AS open FROM action_items a
      WHERE COALESCE((SELECT c.status FROM action_item_status_changes c
        WHERE c.action_item_id = a.id ORDER BY c.created_at DESC LIMIT 1), 'open') = 'open'`)).rows as [{ open: number }];
    const workers = (await ctx.db.execute(sql`
      SELECT DISTINCT ON (worker) worker, status, ran_at FROM worker_runs
      ORDER BY worker, ran_at DESC`)).rows as { worker: string; status: string; ran_at: string }[];
    return { pendingSuggestions: pending, inboxDocs: inbox, openActionItems: open,
      lastWorkerRuns: workers.map((w) => ({ worker: w.worker, status: w.status, ranAt: new Date(w.ran_at) })) };
  }),
});
```
Register in `root.ts`: `dashboard: dashboardRouter,`. Add an integration test asserting the three counts move when you insert a pending suggestion / inbox doc (same style as earlier router tests) in `packages/api/src/routers/dashboard.test.ts`, run it, see it pass.

- [ ] **Step 2: Queue page**

`apps/web/src/components/suggestion-card.tsx`:
```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";

type Proposed = { occurredAt: string; channel: string; direction: "inbound" | "outbound";
  summary: string; details: string; participantNames: string[];
  actionItems: { description: string; clarity: "clear" | "ambiguous" | "already-provided" }[];
  attachmentDocumentIds: string[] };

export function SuggestionCard({ s }: { s: { id: string; kind: string; model: string | null;
  proposed: unknown; rawEmail: { fromAddr: string; subject: string; bodyText: string } | null } }) {
  const router = useRouter();
  const p = s.proposed as Proposed | null;
  const [summary, setSummary] = useState(p?.summary ?? "");
  const [details, setDetails] = useState(p?.details ?? "");
  const approve = trpc.suggestions.approveEntry.useMutation({ onSuccess: () => router.refresh() });
  const reject = trpc.suggestions.reject.useMutation({ onSuccess: () => router.refresh() });
  if (!p) return null;
  return (
    <li className="rounded border bg-white p-4 space-y-3">
      <p className="text-sm text-slate-500">
        {s.rawEmail ? `Email from ${s.rawEmail.fromAddr}: “${s.rawEmail.subject}”` : "Detected item"}
        {s.model && <span> · suggested by {s.model}</span>}
      </p>
      <label className="block text-sm">Summary<input className="w-full border rounded p-2"
        value={summary} onChange={(e) => setSummary(e.target.value)} /></label>
      <label className="block text-sm">Details<textarea className="w-full border rounded p-2" rows={3}
        value={details} onChange={(e) => setDetails(e.target.value)} /></label>
      {s.rawEmail && <details><summary className="cursor-pointer text-sm">Original email</summary>
        <pre className="text-xs whitespace-pre-wrap bg-slate-50 p-2 rounded">{s.rawEmail.bodyText}</pre></details>}
      <div className="flex gap-2">
        <button className="rounded bg-emerald-700 text-white px-4 py-1"
          onClick={() => approve.mutate({ id: s.id, entry: {
            occurredAt: new Date(p.occurredAt), channel: p.channel as "email", direction: p.direction,
            summary, details: details || undefined, source: "gmail-watch",
            participantPartyIds: [], documentIds: p.attachmentDocumentIds,
            actionItems: p.actionItems } })}>Add to the record</button>
        <button className="rounded border px-4 py-1" onClick={() => reject.mutate({ id: s.id })}>Not relevant</button>
      </div>
    </li>
  );
}
```

`apps/web/src/app/queue/page.tsx`:
```tsx
import { serverCaller } from "@/lib/trpc-server";
import { SuggestionCard } from "@/components/suggestion-card";

export default async function QueuePage() {
  const caller = await serverCaller();
  const pending = await caller.suggestions.list({ status: "pending" });
  const manual = await caller.suggestions.list({ status: "needs-manual" });
  const all = [...pending, ...manual];
  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">Review queue</h1>
      <p className="text-slate-600 mb-6">{all.length
        ? `${all.length} suggestion${all.length > 1 ? "s" : ""} waiting — you decide what becomes part of the record.`
        : "Queue is empty. Everything's handled — take a breather. ☕"}</p>
      <ul className="space-y-4 max-w-2xl">{all.map((s) => <SuggestionCard key={s.id} s={s} />)}</ul>
    </div>
  );
}
```

- [ ] **Step 3: Dashboard page**

`apps/web/src/app/dashboard/page.tsx`:
```tsx
import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";

export default async function DashboardPage() {
  const caller = await serverCaller();
  const stats = await caller.dashboard.stats();
  const recent = await caller.entries.list({ limit: 5 });
  const staleMs = 15 * 60 * 1000;
  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">Hi Martin 👋 — here's where things stand</h1>
      <div className="grid grid-cols-3 gap-4">
        <Link href="/queue" className="rounded border bg-white p-4">
          <p className="text-3xl font-bold">{stats.pendingSuggestions}</p><p>to review</p></Link>
        <Link href="/vault" className="rounded border bg-white p-4">
          <p className="text-3xl font-bold">{stats.inboxDocs}</p><p>documents to sort</p></Link>
        <div className="rounded border bg-white p-4">
          <p className="text-3xl font-bold">{stats.openActionItems}</p><p>open actions</p></div>
      </div>
      <section>
        <h2 className="font-semibold mb-2">System health</h2>
        <ul className="text-sm space-y-1">
          {stats.lastWorkerRuns.map((w) => {
            const stale = Date.now() - w.ranAt.getTime() > staleMs;
            return <li key={w.worker}>{stale || w.status !== "ok" ? "🔴" : "🟢"} {w.worker} — last ran {w.ranAt.toLocaleTimeString("nl-NL")} ({w.status})</li>;
          })}
          {stats.lastWorkerRuns.length === 0 && <li>🟡 Watchers haven't reported yet.</li>}
        </ul>
      </section>
      <section>
        <h2 className="font-semibold mb-2">Recently logged</h2>
        <ul className="space-y-1">{recent.map((e) => (
          <li key={e.id}><Link className="hover:underline" href={`/logbook/${e.id}`}>{e.summary}</Link>
            <span className="text-xs text-slate-500"> · {new Date(e.occurredAt).toLocaleDateString("nl-NL")}</span></li>))}</ul>
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Verify manually + commit**

Insert a pending suggestion by running the Task 8 test once (`pnpm --filter @verder/api test suggestions`), then check `/queue` renders it and approve flows through to `/logbook`. Dashboard tiles show non-zero counts.

```bash
git add apps/web packages/api && git commit -m "feat(web): review queue and dashboard with worker health"
```

### Task 14: Verify page + court-ready export

**Files:**
- Create: `apps/web/src/app/verify/page.tsx`, `apps/web/src/components/verify-panel.tsx`, `apps/web/src/app/verify/export/page.tsx`

**Interfaces:**
- Consumes: `verify.run` (mutation), `verify.exportRange` (query).
- Produces: `/verify` (run check, show result + head hash), `/verify/export?from=YYYY-MM-DD&to=YYYY-MM-DD` (print-styled report; browser print-to-PDF is the export mechanism).

- [ ] **Step 1: Verify panel**

`apps/web/src/components/verify-panel.tsx`:
```tsx
"use client";
import { useState } from "react";
import { trpc } from "@/lib/trpc-client";

export function VerifyPanel() {
  const run = trpc.verify.run.useMutation();
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  return (
    <div className="max-w-xl space-y-6">
      <div className="rounded border bg-white p-6 space-y-3">
        <h2 className="font-semibold">Integrity check</h2>
        <p className="text-sm text-slate-600">Recomputes every hash in the chain and re-reads every stored file.</p>
        <button className="rounded bg-slate-900 text-white px-4 py-2" disabled={run.isPending}
          onClick={() => run.mutate()}>{run.isPending ? "Checking…" : "Run verification"}</button>
        {run.data && (run.data.ok
          ? <p className="text-emerald-700">✔ All good. {run.data.count} events verified, {run.data.checkedFiles} files re-hashed.<br />
              <span className="text-xs break-all">Chain head: {run.data.headHash}</span></p>
          : <p className="text-red-700">✘ Chain broken at event {run.data.brokenAtSeq} ({run.data.reason}). Don't panic — nothing is lost; investigate before writing anything new.</p>)}
      </div>
      <div className="rounded border bg-white p-6 space-y-3">
        <h2 className="font-semibold">Export a report</h2>
        <div className="flex gap-2">
          <input type="date" className="border rounded p-2" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input type="date" className="border rounded p-2" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <a className={`inline-block rounded border px-4 py-2 ${!from || !to ? "pointer-events-none opacity-50" : ""}`}
          href={`/verify/export?from=${from}&to=${to}`} target="_blank">Open report (print → PDF)</a>
      </div>
    </div>
  );
}
```

`apps/web/src/app/verify/page.tsx`:
```tsx
import { VerifyPanel } from "@/components/verify-panel";
export default function VerifyPage() {
  return (<div><h1 className="text-2xl font-bold mb-6">Verify & export</h1><VerifyPanel /></div>);
}
```

- [ ] **Step 2: Export report page**

`apps/web/src/app/verify/export/page.tsx`:
```tsx
import { serverCaller } from "@/lib/trpc-server";

export default async function ExportPage({ searchParams }: {
  searchParams: Promise<{ from: string; to: string }> }) {
  const { from, to } = await searchParams;
  const caller = await serverCaller();
  const exp = await caller.verify.exportRange({ from: new Date(from), to: new Date(`${to}T23:59:59Z`) });
  return (
    <main className="mx-auto max-w-3xl p-8 print:p-0 bg-white text-black">
      <header className="border-b pb-4 mb-6">
        <h1 className="text-2xl font-bold">Contact & Evidence Report — M. van der Poel</h1>
        <p className="text-sm">Period {new Date(exp.from).toLocaleDateString("nl-NL")} – {new Date(exp.to).toLocaleDateString("nl-NL")} · generated {new Date(exp.generatedAt).toLocaleString("nl-NL")}</p>
        <p className="text-xs break-all">Ledger head (SHA-256): {exp.headHash ?? "—"}</p>
      </header>
      {exp.entries.map((e) => (
        <article key={e.id} className="mb-6 break-inside-avoid">
          <h2 className="font-semibold">{new Date(e.occurredAt).toLocaleString("nl-NL")} — {e.summary}</h2>
          <p className="text-sm">Channel: {e.channel} ({e.direction}) · logged {new Date(e.recordedAt).toLocaleString("nl-NL")} · source {e.source}{e.supersedesId ? " · correction of an earlier entry" : ""}</p>
          {e.participants.length > 0 && <p className="text-sm">Present/involved: {e.participants.join(", ")}</p>}
          {e.details && <p className="text-sm whitespace-pre-wrap mt-1">{e.details}</p>}
          {e.actionItems.length > 0 && (
            <ul className="text-sm list-disc ml-5 mt-1">
              {e.actionItems.map((a) => <li key={a.id}>{a.description} ({a.clarity})</li>)}
            </ul>)}
          {e.documents.length > 0 && (
            <ul className="text-xs ml-5 mt-1">
              {e.documents.map((d) => <li key={d.sha256} className="break-all">📄 {d.title} — SHA-256 {d.sha256}</li>)}
            </ul>)}
        </article>
      ))}
      <footer className="border-t pt-4 text-xs">
        This report was generated from an append-only, hash-chained log. Any alteration of past entries or files is detectable via the ledger head hash above.
      </footer>
    </main>
  );
}
```
(This page intentionally renders without the app nav: create `apps/web/src/app/verify/export/layout.tsx` returning only `{children}` — Next nested layouts still wrap the root layout, so ALSO guard the root layout nav with the pathname if needed; simplest correct approach: move the sidebar out of the root layout into a `(app)` route group layout and place `verify/export` outside that group.)

- [ ] **Step 3: Verify manually + commit**

Run verification on the seeded data → green. Tamper test on a dev copy only (as postgres superuser: `UPDATE log_entries SET summary='x' WHERE ...`) → verification reports the broken seq. Restore from the transaction you noted or re-seed dev data afterwards. Open the export page, print-preview it.

```bash
git add apps/web && git commit -m "feat(web): verification panel and print-ready evidence report"
```

### Task 15: Worker scaffold + heartbeat + job queue

**Files:**
- Create: `apps/worker/package.json`, `apps/worker/tsconfig.json`, `apps/worker/src/index.ts`, `apps/worker/src/heartbeat.ts`
- Test: `apps/worker/src/heartbeat.test.ts`

**Interfaces:**
- Consumes: `createDb`, schema, pg-boss.
- Produces:
  - `recordRun(db: Db, worker: string, status: "ok" | "error", detail?: unknown): Promise<void>` — inserts into `worker_runs`.
  - Job names: `"gmail.poll"` (cron every 3 min), `"nas.scan"` (cron every 2 min), `"suggest.entry"` (per raw email, data `{ rawEmailId: string }`), `"suggest.docmeta"` (per document, data `{ documentId: string }`), `"push.notify"` (data `{ title: string; body: string }`).
  - `apps/worker/src/index.ts` boots pg-boss on `DATABASE_URL` (admin-role URL `WORKER_DATABASE_URL` — pg-boss needs its own schema; grant `verder_app` nothing here, worker uses its own role `verder_worker` with the same evidence grants plus pg-boss schema ownership), registers handlers, schedules crons. Handlers land in Tasks 16–19; this task registers them as imports with a no-op body replaced later? NO — this task only boots pg-boss + cron registration for a `"heartbeat"` job proving the loop works; each later task adds its own `boss.work(...)` line.

- [ ] **Step 1: Role migration**

New migration `0004_worker_role.sql` (generate custom like Task 5):
```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'verder_worker') THEN
    CREATE ROLE verder_worker LOGIN PASSWORD 'verder_worker';
  END IF;
END $$;
GRANT CONNECT ON DATABASE verder TO verder_worker;
GRANT USAGE ON SCHEMA public TO verder_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO verder_worker;
GRANT SELECT, INSERT ON ledger_events, log_entries, parties, entry_participants,
  documents, entry_documents, action_items, document_status_changes,
  action_item_status_changes, raw_emails TO verder_worker;
GRANT SELECT, INSERT, UPDATE ON suggestions, worker_runs, users TO verder_worker;
GRANT CREATE ON DATABASE verder TO verder_worker; -- pg-boss creates its own schema
```

- [ ] **Step 2: Package + heartbeat with test**

`apps/worker/package.json`:
```json
{
  "name": "worker",
  "private": true,
  "type": "module",
  "scripts": { "dev": "tsx watch src/index.ts", "start": "tsx src/index.ts",
    "test": "vitest run", "typecheck": "tsc --noEmit", "build": "tsc --noEmit" },
  "dependencies": {
    "pg-boss": "^10.1.5", "googleapis": "^144.0.0", "chokidar": "^4.0.1",
    "web-push": "^3.6.7", "pdf-parse": "^1.1.1", "tesseract.js": "^5.1.1",
    "@verder/api": "workspace:*", "@verder/core": "workspace:*", "@verder/db": "workspace:*",
    "drizzle-orm": "^0.38.0", "tsx": "^4.19.2"
  },
  "devDependencies": { "vitest": "^2.1.8", "typescript": "^5.7.2", "@types/web-push": "^3.6.4", "@types/pdf-parse": "^1.1.4" }
}
```

`apps/worker/src/heartbeat.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { createDb, schema } from "@verder/db";
import { recordRun } from "./heartbeat";

const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

describe("recordRun", () => {
  it("records worker heartbeats", async () => {
    const { db, pool } = createDb(URL);
    await recordRun(db, "test-worker", "ok", { polled: 3 });
    const [row] = await db.select().from(schema.workerRuns)
      .where(eq(schema.workerRuns.worker, "test-worker"))
      .orderBy(desc(schema.workerRuns.ranAt)).limit(1);
    expect(row.status).toBe("ok");
    await pool.end();
  });
});
```

Run → FAIL. Implement `apps/worker/src/heartbeat.ts`:
```ts
import { schema, type Db } from "@verder/db";

export async function recordRun(db: Db, worker: string, status: "ok" | "error", detail?: unknown) {
  await db.insert(schema.workerRuns).values({
    worker, status, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail)) });
}
```

Run → PASS.

- [ ] **Step 3: Boot file**

`apps/worker/src/index.ts`:
```ts
import PgBoss from "pg-boss";
import { createDb } from "@verder/db";
import { recordRun } from "./heartbeat";

const url = process.env.WORKER_DATABASE_URL
  ?? "postgres://verder_worker:verder_worker@localhost:5432/verder";
export const { db } = createDb(url);
const boss = new PgBoss(url);

boss.on("error", (err) => { void recordRun(db, "pg-boss", "error", { message: String(err) }); });

await boss.start();
await boss.createQueue("heartbeat");
await boss.schedule("heartbeat", "*/5 * * * *");
await boss.work("heartbeat", async () => { await recordRun(db, "heartbeat", "ok"); });
// Tasks 16–19 append their queues, schedules and workers below this line.
console.log("worker up");
```

Run `pnpm --filter worker dev` for 10s → `worker_runs` may not show yet (5-min cron) — enqueue once manually to confirm: temporarily add `await boss.send("heartbeat", {})`, see a row appear, remove the line.

- [ ] **Step 4: Commit**

```bash
git add apps/worker packages/db && git commit -m "feat(worker): pg-boss scaffold with heartbeat reporting"
```

### Task 16: Gmail watcher

**Files:**
- Create: `apps/worker/src/gmail.ts`, `apps/worker/src/gmail-auth.ts`
- Modify: `apps/worker/src/index.ts` (register queue `gmail.poll`, cron `*/3 * * * *`)
- Test: `apps/worker/src/gmail.test.ts`

**Interfaces:**
- Consumes: `ingestDocument`, `storeFile`, `recordRun`, schema.
- Produces:
  - `interface GmailPort { listMessageIds(query: string): Promise<string[]>; getMessage(id: string): Promise<{ id: string; threadId: string; from: string; to: string; subject: string; sentAt: Date; bodyText: string; raw: Buffer; attachments: { filename: string; mime: string; data: Buffer }[] }> }` — the real implementation wraps googleapis; tests fake it.
  - `pollGmail(deps: { db: Db; gmail: GmailPort; vaultDir: string; enqueueSuggest: (rawEmailId: string) => Promise<void> }): Promise<{ ingested: number }>` — query is `newer_than:7d` filtered to relevant senders (`RELEVANT_SENDERS` env, comma-separated, default `@verdergroep.nl`; plus any address existing as a `parties.email`). For each unseen message (idempotent on `gmailMessageId`): insert `raw_emails` row (raw sha256 of RFC822 bytes), ingest attachments as documents (`source: "email-attachment"`, `sourceRef: gmailMessageId`), enqueue `suggest.entry`.
  - `gmail-auth.ts`: builds an OAuth2 client from `GMAIL_CREDENTIALS_PATH`/`GMAIL_TOKEN_PATH`; separate script `pnpm --filter worker gmail:auth` (add script `"gmail:auth": "tsx src/gmail-auth.ts"`) runs the one-time device authorization and writes the token file (scope `gmail.readonly`).

- [ ] **Step 1: Write failing test with a fake GmailPort**

`apps/worker/src/gmail.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, schema } from "@verder/db";
import { pollGmail, type GmailPort } from "./gmail";

const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

function fakeGmail(id: string): GmailPort {
  const msg = {
    id, threadId: "t-1", from: "case@verdergroep.nl", to: "martin@vanderpoel.pro",
    subject: "Please send your rental contract", sentAt: new Date(),
    bodyText: "Beste Martin, graag je huurcontract opsturen.",
    raw: Buffer.from(`raw-${id}`),
    attachments: [{ filename: "checklist.pdf", mime: "application/pdf", data: Buffer.from(`pdf-${id}`) }],
  };
  return { listMessageIds: async () => [id], getMessage: async () => msg };
}

describe("pollGmail", () => {
  it("ingests raw email + attachment and enqueues suggestion, idempotently", async () => {
    const { db, pool } = createDb(URL);
    const vaultDir = mkdtempSync(join(tmpdir(), "gmail-vault-"));
    const enqueued: string[] = [];
    const deps = { db, gmail: fakeGmail(`m-${Date.now()}`), vaultDir,
      enqueueSuggest: async (x: string) => { enqueued.push(x); } };
    const first = await pollGmail(deps);
    const second = await pollGmail(deps);
    expect(first.ingested).toBe(1);
    expect(second.ingested).toBe(0);          // idempotent
    expect(enqueued).toHaveLength(1);
    const [raw] = await db.select().from(schema.rawEmails)
      .where(eq(schema.rawEmails.id, enqueued[0]));
    expect(raw.subject).toContain("rental contract");
    const docs = await db.select().from(schema.documents)
      .where(eq(schema.documents.sourceRef, raw.gmailMessageId));
    expect(docs).toHaveLength(1);
    expect(docs[0].source).toBe("email-attachment");
    await pool.end();
  });
});
```

- [ ] **Step 2: Run → FAIL, then implement**

`apps/worker/src/gmail.ts`:
```ts
import { eq } from "drizzle-orm";
import { sha256Hex } from "@verder/core";
import { schema, type Db } from "@verder/db";
import { ingestDocument } from "@verder/api/src/routers/documents";
import { storeFile } from "@verder/api/src/storage";
import { recordRun } from "./heartbeat";

export interface GmailMessage {
  id: string; threadId: string; from: string; to: string; subject: string;
  sentAt: Date; bodyText: string; raw: Buffer;
  attachments: { filename: string; mime: string; data: Buffer }[];
}
export interface GmailPort {
  listMessageIds(query: string): Promise<string[]>;
  getMessage(id: string): Promise<GmailMessage>;
}

export async function pollGmail(deps: {
  db: Db; gmail: GmailPort; vaultDir: string;
  enqueueSuggest: (rawEmailId: string) => Promise<void>;
}): Promise<{ ingested: number }> {
  const senders = (process.env.RELEVANT_SENDERS ?? "@verdergroep.nl").split(",");
  const partyEmails = (await deps.db.select().from(schema.parties))
    .map((p) => p.email).filter((e): e is string => !!e);
  const ids = await deps.gmail.listMessageIds("newer_than:7d");
  let ingested = 0;
  try {
    for (const id of ids) {
      const [seen] = await deps.db.select().from(schema.rawEmails)
        .where(eq(schema.rawEmails.gmailMessageId, id));
      if (seen) continue;
      const msg = await deps.gmail.getMessage(id);
      const relevant = [...senders, ...partyEmails]
        .some((s) => msg.from.toLowerCase().includes(s.toLowerCase()));
      if (!relevant) continue;
      const rawEmailId = await deps.db.transaction(async (tx) => {
        const [row] = await tx.insert(schema.rawEmails).values({
          gmailMessageId: msg.id, gmailThreadId: msg.threadId,
          fromAddr: msg.from, toAddr: msg.to, subject: msg.subject,
          sentAt: msg.sentAt, rawRfc822Sha256: sha256Hex(msg.raw),
          bodyText: msg.bodyText,
        }).returning();
        for (const att of msg.attachments) {
          const { sha256 } = await storeFile(deps.vaultDir, att.data);
          await ingestDocument(tx, { sha256, sizeBytes: att.data.length,
            mime: att.mime, title: att.filename, source: "email-attachment",
            sourceRef: msg.id, receivedAt: msg.sentAt });
        }
        return row.id;
      });
      await deps.enqueueSuggest(rawEmailId);
      ingested++;
    }
    await recordRun(deps.db, "gmail", "ok", { ingested, scanned: ids.length });
  } catch (err) {
    await recordRun(deps.db, "gmail", "error", { message: String(err) });
    throw err;
  }
  return { ingested };
}
```

Run test → PASS.

- [ ] **Step 3: Real GmailPort + registration**

`apps/worker/src/gmail-auth.ts`:
```ts
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { google } from "googleapis";
import type { GmailMessage, GmailPort } from "./gmail";

export async function oauthClient() {
  const creds = JSON.parse(await readFile(process.env.GMAIL_CREDENTIALS_PATH!, "utf8"));
  const { client_id, client_secret } = creds.installed ?? creds.web;
  const client = new google.auth.OAuth2(client_id, client_secret, "urn:ietf:wg:oauth:2.0:oob");
  try {
    client.setCredentials(JSON.parse(await readFile(process.env.GMAIL_TOKEN_PATH!, "utf8")));
  } catch { /* not yet authorized */ }
  return client;
}

export async function realGmailPort(): Promise<GmailPort> {
  const auth = await oauthClient();
  const gmail = google.gmail({ version: "v1", auth });
  return {
    async listMessageIds(query) {
      const res = await gmail.users.messages.list({ userId: "me", q: query, maxResults: 50 });
      return (res.data.messages ?? []).map((m) => m.id!);
    },
    async getMessage(id): Promise<GmailMessage> {
      const raw = await gmail.users.messages.get({ userId: "me", id, format: "raw" });
      const full = await gmail.users.messages.get({ userId: "me", id, format: "full" });
      const headers = Object.fromEntries((full.data.payload?.headers ?? [])
        .map((h) => [h.name!.toLowerCase(), h.value ?? ""]));
      const attachments: GmailMessage["attachments"] = [];
      const walk = async (part: NonNullable<typeof full.data.payload>) => {
        for (const p of part.parts ?? []) {
          if (p.filename && p.body?.attachmentId) {
            const att = await gmail.users.messages.attachments.get({
              userId: "me", messageId: id, id: p.body.attachmentId });
            attachments.push({ filename: p.filename, mime: p.mimeType ?? "application/octet-stream",
              data: Buffer.from(att.data.data!, "base64url") });
          }
          if (p.parts) await walk(p);
        }
      };
      if (full.data.payload) await walk(full.data.payload);
      const bodyPart = findTextPart(full.data.payload);
      return {
        id, threadId: full.data.threadId!, from: headers.from ?? "", to: headers.to ?? "",
        subject: headers.subject ?? "(no subject)",
        sentAt: new Date(Number(full.data.internalDate)),
        bodyText: bodyPart ? Buffer.from(bodyPart, "base64url").toString("utf8") : "",
        raw: Buffer.from(raw.data.raw!, "base64url"), attachments,
      };
    },
  };
}

function findTextPart(payload: unknown): string | null {
  const p = payload as { mimeType?: string; body?: { data?: string }; parts?: unknown[] } | undefined;
  if (!p) return null;
  if (p.mimeType === "text/plain" && p.body?.data) return p.body.data;
  for (const child of p.parts ?? []) { const r = findTextPart(child); if (r) return r; }
  return null;
}

// One-time interactive authorization when run directly: `pnpm --filter worker gmail:auth`
if (import.meta.url === `file://${process.argv[1]}`) {
  const client = await oauthClient();
  const url = client.generateAuthUrl({ access_type: "offline",
    scope: ["https://www.googleapis.com/auth/gmail.readonly"] });
  console.log("Open this URL, approve, paste the code:\n", url);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const code = await rl.question("Code: ");
  const { tokens } = await client.getToken(code.trim());
  await writeFile(process.env.GMAIL_TOKEN_PATH!, JSON.stringify(tokens));
  console.log("Token saved. Gmail watching is ready to go.");
  process.exit(0);
}
```

Append to `apps/worker/src/index.ts`:
```ts
import { pollGmail } from "./gmail";
import { realGmailPort } from "./gmail-auth";

await boss.createQueue("gmail.poll");
await boss.createQueue("suggest.entry");
await boss.schedule("gmail.poll", "*/3 * * * *");
await boss.work("gmail.poll", async () => {
  const gmail = await realGmailPort();
  await pollGmail({ db, gmail, vaultDir: process.env.VAULT_DIR ?? "./vault-files",
    enqueueSuggest: async (rawEmailId) => { await boss.send("suggest.entry", { rawEmailId }); } });
});
```

- [ ] **Step 4: Commit**

```bash
git add apps/worker && git commit -m "feat(worker): gmail watcher with idempotent evidence-first ingestion"
```

### Task 17: Ollama suggestion pipeline + eval baseline

**Files:**
- Create: `apps/worker/src/prompts.ts`, `apps/worker/src/ollama.ts`, `apps/worker/src/eval/run-eval.ts`, `apps/worker/src/eval/samples.json`
- Modify: `apps/worker/src/index.ts` (register `suggest.entry` and `suggest.docmeta` workers)
- Test: `apps/worker/src/ollama.test.ts`

**Interfaces:**
- Consumes: schema, `recordRun`; Ollama HTTP API (`POST {OLLAMA_URL}/api/chat` with `format: "json"`).
- Produces:
  - `PROMPT_VERSION = "entry-v1"` and `buildEntryPrompt(email: { from: string; subject: string; sentAt: Date; bodyText: string }): string` in `prompts.ts`.
  - `interface LlmPort { chatJson(prompt: string): Promise<unknown> }` — real impl calls Ollama; tests fake it.
  - `suggestEntry(deps: { db: Db; llm: LlmPort }, rawEmailId: string): Promise<void>` — loads raw email + its attachment document ids, calls LLM, zod-parses the reply into the Task 8 proposed-payload shape, inserts a `suggestions` row (`kind: "log-entry"`, model from `OLLAMA_MODEL`, promptVersion). On LLM error/timeout/unparseable output: inserts the suggestion with `status: "needs-manual"`, `proposed` filled from the email itself (`summary: subject`, `details: bodyText` truncated to 2000 chars, empty actionItems) so nothing vanishes.
  - `suggestDocMeta(deps, documentId)` — extracts text (pdf-parse for PDFs, tesseract.js `eng+nld` for images, else none), asks LLM for `{ title, docType }`, inserts `kind: "document-meta"` suggestion; same needs-manual fallback (proposed = `{ title: current title, docType: null }`).
  - Eval: `pnpm --filter worker eval` (script `"eval": "tsx src/eval/run-eval.ts"`) runs `buildEntryPrompt` + real Ollama over `samples.json` (6 Dutch fixture emails with expected summaries/action-item counts), prints per-sample pass/fail and a total score. This is the golden-rule accuracy baseline.

- [ ] **Step 1: Write failing tests**

`apps/worker/src/ollama.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { createDb, schema } from "@verder/db";
import { suggestEntry, type LlmPort } from "./ollama";

const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

async function insertEmail(db: ReturnType<typeof createDb>["db"]) {
  const [raw] = await db.insert(schema.rawEmails).values({
    gmailMessageId: `eval-${crypto.randomUUID()}`, gmailThreadId: "t",
    fromAddr: "case@verdergroep.nl", toAddr: "martin@vanderpoel.pro",
    subject: "Huurcontract opsturen", sentAt: new Date(),
    rawRfc822Sha256: "b".repeat(64),
    bodyText: "Beste Martin, stuur je huurcontract voor vrijdag op.",
  }).returning();
  return raw;
}

describe("suggestEntry", () => {
  it("stores a parsed LLM suggestion with model + prompt version", async () => {
    const { db, pool } = createDb(URL);
    const raw = await insertEmail(db);
    const llm: LlmPort = { chatJson: async () => ({
      summary: "VerderGroep vraagt huurcontract",
      details: "Huurcontract voor vrijdag opsturen.",
      direction: "inbound",
      actionItems: [{ description: "Huurcontract opsturen", clarity: "clear" }] }) };
    await suggestEntry({ db, llm }, raw.id);
    const [s] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.rawEmailId, raw.id));
    expect(s.status).toBe("pending");
    expect(s.promptVersion).toBe("entry-v1");
    expect((s.proposed as { summary: string }).summary).toContain("huurcontract".slice(0, 4));
    await pool.end();
  });

  it("falls back to needs-manual when the LLM fails", async () => {
    const { db, pool } = createDb(URL);
    const raw = await insertEmail(db);
    const llm: LlmPort = { chatJson: async () => { throw new Error("ollama down"); } };
    await suggestEntry({ db, llm }, raw.id);
    const [s] = await db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.rawEmailId, raw.id))
      .orderBy(desc(schema.suggestions.createdAt)).limit(1);
    expect(s.status).toBe("needs-manual");
    expect((s.proposed as { summary: string }).summary).toBe("Huurcontract opsturen");
    await pool.end();
  });
});
```

- [ ] **Step 2: Run → FAIL, then implement**

`apps/worker/src/prompts.ts`:
```ts
export const PROMPT_VERSION = "entry-v1";

export function buildEntryPrompt(email: {
  from: string; subject: string; sentAt: Date; bodyText: string;
}): string {
  return [
    "You are helping maintain a legal-grade contact log for a Dutch debt-restructuring (WSNP/bewindvoering) case.",
    "The email below may be in Dutch. Extract a log entry as strict JSON with keys:",
    `summary (string, <=100 chars, in the email's language), details (string, 1-3 sentences),`,
    `direction ("inbound" or "outbound"), actionItems (array of {description, clarity}),`,
    `where clarity is "clear" if the request is unambiguous, "ambiguous" otherwise.`,
    "Only include actionItems actually requested. Reply with JSON only.",
    "",
    `From: ${email.from}`,
    `Date: ${email.sentAt.toISOString()}`,
    `Subject: ${email.subject}`,
    "",
    email.bodyText.slice(0, 6000),
  ].join("\n");
}

export const DOCMETA_PROMPT_VERSION = "docmeta-v1";
export function buildDocMetaPrompt(filename: string, text: string): string {
  return [
    "A scanned document for a Dutch debt-administration dossier. From the filename and extracted text,",
    `reply with strict JSON: { "title": string (short, descriptive, keep language), "docType": one of`,
    `"contract","payslip","invoice","letter","bank-statement","id-document","other" }.`,
    `Filename: ${filename}`,
    "Extracted text:", text.slice(0, 4000),
  ].join("\n");
}
```

`apps/worker/src/ollama.ts`:
```ts
import { z } from "zod";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { recordRun } from "./heartbeat";
import { buildDocMetaPrompt, buildEntryPrompt, DOCMETA_PROMPT_VERSION, PROMPT_VERSION } from "./prompts";

export interface LlmPort { chatJson(prompt: string): Promise<unknown> }

export function realLlmPort(): LlmPort {
  return {
    async chatJson(prompt) {
      const res = await fetch(`${process.env.OLLAMA_URL ?? "http://localhost:11434"}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: process.env.OLLAMA_MODEL ?? "qwen2.5:14b",
          messages: [{ role: "user", content: prompt }], format: "json", stream: false }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`ollama ${res.status}`);
      const data = (await res.json()) as { message: { content: string } };
      return JSON.parse(data.message.content);
    },
  };
}

const llmEntrySchema = z.object({
  summary: z.string().min(1).max(200),
  details: z.string().default(""),
  direction: z.enum(["inbound", "outbound"]).default("inbound"),
  actionItems: z.array(z.object({
    description: z.string().min(1),
    clarity: z.enum(["clear", "ambiguous", "already-provided"]).default("clear"),
  })).default([]),
});

export async function suggestEntry(deps: { db: Db; llm: LlmPort }, rawEmailId: string) {
  const [email] = await deps.db.select().from(schema.rawEmails)
    .where(eq(schema.rawEmails.id, rawEmailId));
  if (!email) return;
  const attachmentDocs = await deps.db.select().from(schema.documents)
    .where(eq(schema.documents.sourceRef, email.gmailMessageId));
  const base = { occurredAt: email.sentAt.toISOString(), channel: "email" as const,
    participantNames: [email.fromAddr],
    attachmentDocumentIds: attachmentDocs.map((d) => d.id) };
  const model = process.env.OLLAMA_MODEL ?? "qwen2.5:14b";
  try {
    const parsed = llmEntrySchema.parse(await deps.llm.chatJson(buildEntryPrompt({
      from: email.fromAddr, subject: email.subject, sentAt: email.sentAt, bodyText: email.bodyText })));
    await deps.db.insert(schema.suggestions).values({
      kind: "log-entry", rawEmailId, model, promptVersion: PROMPT_VERSION,
      proposed: { ...base, direction: parsed.direction, summary: parsed.summary,
        details: parsed.details, actionItems: parsed.actionItems } });
    await recordRun(deps.db, "ollama", "ok", { rawEmailId });
  } catch (err) {
    await deps.db.insert(schema.suggestions).values({
      kind: "log-entry", rawEmailId, model, promptVersion: PROMPT_VERSION,
      status: "needs-manual",
      proposed: { ...base, direction: "inbound", summary: email.subject,
        details: email.bodyText.slice(0, 2000), actionItems: [] } });
    await recordRun(deps.db, "ollama", "error", { rawEmailId, message: String(err) });
  }
}

const llmDocSchema = z.object({ title: z.string().min(1), docType: z.string().nullable().default(null) });

export async function suggestDocMeta(
  deps: { db: Db; llm: LlmPort; extractText: (mime: string, buf: Buffer) => Promise<string> },
  documentId: string, fileBuf: Buffer
) {
  const [doc] = await deps.db.select().from(schema.documents)
    .where(eq(schema.documents.id, documentId));
  if (!doc) return;
  const model = process.env.OLLAMA_MODEL ?? "qwen2.5:14b";
  try {
    const text = await deps.extractText(doc.mime, fileBuf);
    const parsed = llmDocSchema.parse(
      await deps.llm.chatJson(buildDocMetaPrompt(doc.title, text)));
    await deps.db.insert(schema.suggestions).values({
      kind: "document-meta", documentId, model, promptVersion: DOCMETA_PROMPT_VERSION,
      proposed: parsed });
  } catch (err) {
    await deps.db.insert(schema.suggestions).values({
      kind: "document-meta", documentId, model, promptVersion: DOCMETA_PROMPT_VERSION,
      status: "needs-manual", proposed: { title: doc.title, docType: null } });
    await recordRun(deps.db, "ollama", "error", { documentId, message: String(err) });
  }
}
```

Run tests → PASS.

- [ ] **Step 3: Register workers + text extraction**

Append to `apps/worker/src/index.ts`:
```ts
import { readFile } from "node:fs/promises";
import { realLlmPort, suggestDocMeta, suggestEntry } from "./ollama";
import { readFilePath } from "@verder/api/src/storage";
import { schema } from "@verder/db";
import { eq } from "drizzle-orm";

const llm = realLlmPort();

async function extractText(mime: string, buf: Buffer): Promise<string> {
  if (mime === "application/pdf") {
    const pdfParse = (await import("pdf-parse")).default;
    return (await pdfParse(buf)).text;
  }
  if (mime.startsWith("image/")) {
    const { recognize } = await import("tesseract.js");
    return (await recognize(buf, "nld+eng")).data.text;
  }
  return "";
}

await boss.work("suggest.entry", async ([job]) => {
  await suggestEntry({ db, llm }, (job.data as { rawEmailId: string }).rawEmailId);
});

await boss.createQueue("suggest.docmeta");
await boss.work("suggest.docmeta", async ([job]) => {
  const { documentId } = job.data as { documentId: string };
  const [doc] = await db.select().from(schema.documents)
    .where(eq(schema.documents.id, documentId));
  if (!doc) return;
  const buf = await readFile(readFilePath(process.env.VAULT_DIR ?? "./vault-files", doc.sha256));
  await suggestDocMeta({ db, llm, extractText }, documentId, buf);
});
```

- [ ] **Step 4: Eval fixtures + script**

`apps/worker/src/eval/samples.json` — write 6 realistic Dutch emails, e.g.:
```json
[
  { "from": "j.devries@verdergroep.nl", "subject": "Aanleveren loonstroken",
    "bodyText": "Beste heer Van der Poel, voor de boedelafdracht hebben wij uw loonstroken van juni en juli nodig. Graag uiterlijk vrijdag aanleveren via de mail.",
    "expect": { "actionItemCount": 1, "summaryContains": "loonstro" } },
  { "from": "incasso@energieleverancier.nl", "subject": "Betalingsherinnering factuur 2024-8812",
    "bodyText": "Geachte heer, wij hebben uw betaling van factuur 2024-8812 ad EUR 214,80 nog niet ontvangen. U kunt contact opnemen met uw bewindvoerder.",
    "expect": { "actionItemCount": 0, "summaryContains": "factuur" } }
]
```
(Add four more in the same shape: an appointment confirmation, a request for the rental contract, a WSNP status update with no action, and an ambiguous "kunt u nog even naar de stukken kijken" email expecting `clarity: "ambiguous"`.)

`apps/worker/src/eval/run-eval.ts`:
```ts
import samples from "./samples.json" with { type: "json" };
import { realLlmPort } from "../ollama";
import { buildEntryPrompt, PROMPT_VERSION } from "../prompts";
import { z } from "zod";

const shape = z.object({ summary: z.string(), actionItems: z.array(z.object({ description: z.string(), clarity: z.string() })).default([]) });
const llm = realLlmPort();
let pass = 0;
for (const s of samples) {
  const out = shape.safeParse(await llm.chatJson(
    buildEntryPrompt({ from: s.from, subject: s.subject, sentAt: new Date(), bodyText: s.bodyText })));
  const ok = out.success
    && out.data.actionItems.length === s.expect.actionItemCount
    && out.data.summary.toLowerCase().includes(s.expect.summaryContains);
  console.log(`${ok ? "PASS" : "FAIL"} — ${s.subject}${ok ? "" : ` → ${JSON.stringify(out.success ? out.data : out.error.issues)}`}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${samples.length} with model=${process.env.OLLAMA_MODEL ?? "qwen2.5:14b"} prompt=${PROMPT_VERSION}`);
```

Run against the homelab Ollama: `OLLAMA_URL=http://<homelab>:11434 pnpm --filter worker eval`. Record the score in the commit message — that's the baseline.

- [ ] **Step 5: Commit**

```bash
git add apps/worker && git commit -m "feat(worker): ollama suggestion pipeline with needs-manual fallback (eval baseline: N/6)"
```

### Task 18: NAS scan watcher

**Files:**
- Create: `apps/worker/src/nas.ts`
- Modify: `apps/worker/src/index.ts` (register queue `nas.scan`, cron `*/2 * * * *`)
- Test: `apps/worker/src/nas.test.ts`

**Interfaces:**
- Consumes: `storeFile`, `ingestDocument`, `recordRun`.
- Produces: `scanNasFolder(deps: { db: Db; scanDir: string; vaultDir: string; enqueueDocMeta: (documentId: string) => Promise<void> }): Promise<{ ingested: number }>` — lists files in `scanDir` (non-recursive), skips files modified <10s ago (may still be writing), hashes each; unseen sha256 → `ingestDocument` (`source: "nas-scan"`, `sourceRef: filename`, title = filename) + enqueue `suggest.docmeta`. Never deletes or moves the NAS original. Polling via cron, not fs-events — a NAS mount makes inotify unreliable; cron is the boring correct choice (drop chokidar from deps if unused).

- [ ] **Step 1: Failing test**

`apps/worker/src/nas.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@verder/db";
import { sha256Hex } from "@verder/core";
import { scanNasFolder } from "./nas";

const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

describe("scanNasFolder", () => {
  it("ingests settled files once and enqueues docmeta suggestions", async () => {
    const { db, pool } = createDb(URL);
    const scanDir = mkdtempSync(join(tmpdir(), "nas-"));
    const vaultDir = mkdtempSync(join(tmpdir(), "nas-vault-"));
    const content = Buffer.from(`scan-${Date.now()}`);
    const file = join(scanDir, "scan_0001.pdf");
    await writeFile(file, content);
    const old = new Date(Date.now() - 60_000);
    await utimes(file, old, old); // settled
    const enq: string[] = [];
    const deps = { db, scanDir, vaultDir, enqueueDocMeta: async (d: string) => { enq.push(d); } };
    expect((await scanNasFolder(deps)).ingested).toBe(1);
    expect((await scanNasFolder(deps)).ingested).toBe(0); // idempotent
    expect(enq).toHaveLength(1);
    const [doc] = await db.select().from(schema.documents)
      .where(eq(schema.documents.sha256, sha256Hex(content)));
    expect(doc.source).toBe("nas-scan");
    expect(doc.title).toBe("scan_0001.pdf");
    await pool.end();
  });
});
```

- [ ] **Step 2: Run → FAIL, then implement**

`apps/worker/src/nas.ts`:
```ts
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { eq } from "drizzle-orm";
import { sha256Hex } from "@verder/core";
import { schema, type Db } from "@verder/db";
import { ingestDocument } from "@verder/api/src/routers/documents";
import { storeFile } from "@verder/api/src/storage";
import { recordRun } from "./heartbeat";

const MIME: Record<string, string> = { ".pdf": "application/pdf", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".tiff": "image/tiff" };

export async function scanNasFolder(deps: {
  db: Db; scanDir: string; vaultDir: string;
  enqueueDocMeta: (documentId: string) => Promise<void>;
}): Promise<{ ingested: number }> {
  let ingested = 0;
  try {
    for (const name of await readdir(deps.scanDir)) {
      const abs = join(deps.scanDir, name);
      const st = await stat(abs);
      if (!st.isFile() || Date.now() - st.mtimeMs < 10_000) continue;
      const buf = await readFile(abs);
      const sha = sha256Hex(buf);
      const [seen] = await deps.db.select().from(schema.documents)
        .where(eq(schema.documents.sha256, sha));
      if (seen) continue;
      await storeFile(deps.vaultDir, buf);
      const doc = await deps.db.transaction((tx) => ingestDocument(tx, {
        sha256: sha, sizeBytes: buf.length,
        mime: MIME[extname(name).toLowerCase()] ?? "application/octet-stream",
        title: name, source: "nas-scan", sourceRef: name, receivedAt: st.mtime }));
      await deps.enqueueDocMeta(doc.id);
      ingested++;
    }
    await recordRun(deps.db, "nas", "ok", { ingested });
  } catch (err) {
    await recordRun(deps.db, "nas", "error", { message: String(err) });
    throw err;
  }
  return { ingested };
}
```

Append to `apps/worker/src/index.ts`:
```ts
import { scanNasFolder } from "./nas";

await boss.createQueue("nas.scan");
await boss.schedule("nas.scan", "*/2 * * * *");
await boss.work("nas.scan", async () => {
  await scanNasFolder({ db, scanDir: process.env.NAS_SCAN_DIR ?? "/mnt/nas/scans",
    vaultDir: process.env.VAULT_DIR ?? "./vault-files",
    enqueueDocMeta: async (documentId) => { await boss.send("suggest.docmeta", { documentId }); } });
});
```

Run test → PASS.

- [ ] **Step 3: Queue page support for document-meta suggestions**

The Task 13 queue renders `kind: "log-entry"` cards. Add to `apps/web/src/components/suggestion-card.tsx` a branch for `kind === "document-meta"`: show proposed `title`/`docType` in two inputs with "Looks right" → `trpc.suggestions.approveDocumentMeta.mutate({ id, title, docType })` and "Not relevant" → reject. Include the document preview thumbnail via `/api/files/<sha>` (extend `suggestions.list` to join the document row like it joins `rawEmail`). Follow the exact patterns already in the file.

- [ ] **Step 4: Commit**

```bash
git add apps/worker apps/web packages/api && git commit -m "feat(worker): NAS scan watcher with settle detection and docmeta suggestions"
```

### Task 19: Web push notifications

**Files:**
- Create: `apps/web/public/sw.js`, `apps/web/src/components/enable-push.tsx`, `apps/worker/src/push.ts`
- Modify: `packages/db/src/schema.ts` (add `pushSubscriptions` table + migration `0005`), `packages/api` (new `push` router: `subscribe`, `vapidPublicKey`), `apps/worker/src/index.ts` (send push after each new suggestion), `apps/web/src/app/dashboard/page.tsx` (mount `<EnablePush />`)
- Test: `apps/worker/src/push.test.ts`

**Interfaces:**
- Consumes: `web-push` lib; VAPID keys from env `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` (generate once: `npx web-push generate-vapid-keys`).
- Produces:
  - Schema: `pushSubscriptions { id uuid pk, endpoint text unique, p256dh text, auth text, createdAt }` (operational table: grant INSERT/SELECT/UPDATE to both roles; deletes of dead subscriptions happen via a `revoked boolean` UPDATE, not DELETE).
  - API: `push.vapidPublicKey` (public query), `push.subscribe({ endpoint, keys: { p256dh, auth } })` (upsert).
  - Worker: `sendPush(db, payload: { title: string; body: string }): Promise<void>` — sends to all non-revoked subscriptions, marks 404/410 responses revoked. Called after `suggestEntry`/`suggestDocMeta` insert a suggestion: payload title "Something new to review 📬", body = email subject or filename.
  - `sw.js`: `self.addEventListener("push", (e) => { const d = e.data.json(); e.waitUntil(self.registration.showNotification(d.title, { body: d.body })); }); self.addEventListener("notificationclick", (e) => { e.notification.close(); e.waitUntil(clients.openWindow("/queue")); });`
  - `enable-push.tsx`: button "Notify me on my phone/laptop" → registers `/sw.js`, `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`, posts to `push.subscribe`.

- [ ] **Step 1: Failing worker test** — fake the web-push transport:

`apps/worker/src/push.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createDb, schema } from "@verder/db";
import { eq } from "drizzle-orm";
import { sendPush, type PushTransport } from "./push";

const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

describe("sendPush", () => {
  it("sends to live subscriptions and revokes dead ones", async () => {
    const { db, pool } = createDb(URL);
    const [live] = await db.insert(schema.pushSubscriptions).values({
      endpoint: `https://push.example/${crypto.randomUUID()}`, p256dh: "k", auth: "a" }).returning();
    const [dead] = await db.insert(schema.pushSubscriptions).values({
      endpoint: `https://push.example/dead-${crypto.randomUUID()}`, p256dh: "k", auth: "a" }).returning();
    const sent: string[] = [];
    const transport: PushTransport = { send: async (sub) => {
      if (sub.endpoint.includes("dead")) { const e = new Error("gone") as Error & { statusCode: number }; e.statusCode = 410; throw e; }
      sent.push(sub.endpoint); } };
    await sendPush(db, { title: "t", body: "b" }, transport);
    expect(sent).toContain(live.endpoint);
    const [deadAfter] = await db.select().from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.id, dead.id));
    expect(deadAfter.revoked).toBe(true);
    await pool.end();
  });
});
```

- [ ] **Step 2: Implement** (`apps/worker/src/push.ts`):
```ts
import webpush from "web-push";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@verder/db";

export interface PushTransport {
  send(sub: { endpoint: string; p256dh: string; auth: string }, payload: string): Promise<unknown>;
}

export function realTransport(): PushTransport {
  webpush.setVapidDetails("mailto:martin@vanderpoel.pro",
    process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
  return { send: (sub, payload) => webpush.sendNotification(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload) };
}

export async function sendPush(db: Db, payload: { title: string; body: string },
  transport: PushTransport = realTransport()) {
  const subs = await db.select().from(schema.pushSubscriptions)
    .where(eq(schema.pushSubscriptions.revoked, false));
  for (const sub of subs) {
    try { await transport.send(sub, JSON.stringify(payload)); }
    catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410)
        await db.update(schema.pushSubscriptions).set({ revoked: true })
          .where(eq(schema.pushSubscriptions.id, sub.id));
    }
  }
}
```

Schema addition (then `generate` + `migrate` + grants in `0005`):
```ts
export const pushSubscriptions = pgTable("push_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  revoked: boolean("revoked").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

API router `packages/api/src/routers/push.ts`:
```ts
import { z } from "zod";
import { schema } from "@verder/db";
import { protectedProcedure, publicProcedure, router } from "../trpc";

export const pushRouter = router({
  vapidPublicKey: publicProcedure.query(() => process.env.VAPID_PUBLIC_KEY ?? null),
  subscribe: protectedProcedure.input(z.object({
    endpoint: z.string().url(),
    keys: z.object({ p256dh: z.string(), auth: z.string() }),
  })).mutation(({ ctx, input }) =>
    ctx.db.insert(schema.pushSubscriptions)
      .values({ endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth })
      .onConflictDoUpdate({ target: schema.pushSubscriptions.endpoint,
        set: { p256dh: input.keys.p256dh, auth: input.keys.auth, revoked: false } })),
});
```
Register `push: pushRouter` in root. Wire worker: after each suggestion insert in `suggestEntry`/`suggestDocMeta`, call `sendPush(deps.db, { title: "Something new to review 📬", body: <subject or filename> })` — inject `sendPush` as an optional dep defaulting to the real one so the Task 17 tests don't send anything (pass a no-op in tests).

`apps/web/src/components/enable-push.tsx`:
```tsx
"use client";
import { trpc } from "@/lib/trpc-client";

export function EnablePush() {
  const key = trpc.push.vapidPublicKey.useQuery();
  const subscribe = trpc.push.subscribe.useMutation();
  if (!key.data) return null;
  return (
    <button className="rounded border px-3 py-1 text-sm" onClick={async () => {
      const reg = await navigator.serviceWorker.register("/sw.js");
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key.data! });
      const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
      subscribe.mutate(json);
    }}>🔔 Notify me when something needs review</button>
  );
}
```

Run tests (`pnpm --filter worker test push`) → PASS. Manual check: enable push in the browser, insert a fake suggestion, confirm a notification arrives and clicking it opens `/queue`.

- [ ] **Step 3: Commit**

```bash
git add apps/web apps/worker packages/api packages/db && git commit -m "feat: web push notifications for new review items"
```

### Task 20: Production deployment + nightly job

**Files:**
- Create: `apps/web/Dockerfile`, `apps/worker/Dockerfile`, `docker-compose.prod.yml`, `ops/nightly.sh`, `ops/check-model-updates.ts` (lives in `apps/worker/src/ops/check-model-updates.ts`, script `"model-check": "tsx src/ops/check-model-updates.ts"`), `docs/deploy.md`

**Interfaces:**
- Consumes: everything.
- Produces: the running system on the homelab, reachable through the existing cloudflared tunnel; nightly cron on the homelab host running `ops/nightly.sh`.

- [ ] **Step 1: Dockerfiles**

`apps/web/Dockerfile` (repo-root build context):
```dockerfile
FROM node:22-slim AS deps
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile
RUN pnpm --filter web build

FROM node:22-slim
RUN corepack enable
WORKDIR /repo
COPY --from=deps /repo ./
EXPOSE 3000
CMD ["pnpm", "--filter", "web", "start"]
```

`apps/worker/Dockerfile`:
```dockerfile
FROM node:22-slim
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker
RUN pnpm install --frozen-lockfile
CMD ["pnpm", "--filter", "worker", "start"]
```

- [ ] **Step 2: Prod compose**

`docker-compose.prod.yml`:
```yaml
services:
  postgres:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_USER: verder
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: verder
    volumes: [pgdata:/var/lib/postgresql/data]
  web:
    build: { context: ., dockerfile: apps/web/Dockerfile }
    restart: unless-stopped
    env_file: .env.prod
    ports: ["127.0.0.1:3000:3000"]
    volumes: ["${VAULT_HOST_DIR}:/vault"]
    depends_on: [postgres]
  worker:
    build: { context: ., dockerfile: apps/worker/Dockerfile }
    restart: unless-stopped
    env_file: .env.prod
    volumes:
      - "${VAULT_HOST_DIR}:/vault"
      - "${NAS_SCAN_HOST_DIR}:/scans:ro"
      - "./secrets:/repo/secrets"
    depends_on: [postgres]
volumes:
  pgdata:
```
`.env.prod` sets `DATABASE_URL=postgres://verder_app:...@postgres:5432/verder`, `WORKER_DATABASE_URL=postgres://verder_worker:...@postgres:5432/verder`, `VAULT_DIR=/vault`, `NAS_SCAN_DIR=/scans`, `OLLAMA_URL=http://<homelab-lan-ip>:11434`, `APP_URL=https://<your-tunnel-hostname>`, plus `AUTH_SECRET`, VAPID keys, `RELEVANT_SENDERS`. Migrations run from the repo checkout on the host (`DATABASE_URL=<admin url> pnpm --filter @verder/db migrate`), not from containers. Point the existing cloudflared tunnel at `http://localhost:3000` and (recommended) put Cloudflare Access in front of the hostname. Change `verder_app`/`verder_worker` role passwords from the dev defaults as part of this step (`ALTER ROLE ... PASSWORD ...`).

- [ ] **Step 3: Nightly script**

`ops/nightly.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
STAMP=$(date +%F)
BACKUP_DIR=${BACKUP_DIR:-/mnt/nas/verder-backups}

docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U verder verder | gzip > "$BACKUP_DIR/db-$STAMP.sql.gz"
rsync -a "${VAULT_HOST_DIR:?}/" "$BACKUP_DIR/vault/"
find "$BACKUP_DIR" -name 'db-*.sql.gz' -mtime +30 -delete

# Full chain verification via the worker image (writes result to worker_runs)
docker compose -f docker-compose.prod.yml exec -T worker \
  pnpm --filter worker exec tsx src/ops/verify-nightly.ts

docker compose -f docker-compose.prod.yml exec -T worker \
  pnpm --filter worker model-check
```
`apps/worker/src/ops/verify-nightly.ts` — loads all ledger events with the worker db, calls `verifyChain` with the same file-recompute callback as `verify.run` (extract that callback into `packages/api/src/verification.ts` as `runFullVerification(db, vaultDir)` and have both the router and this script call it), then `recordRun(db, "nightly-verify", ok ? "ok" : "error", result)`.

`apps/worker/src/ops/check-model-updates.ts`:
```ts
import { createDb } from "@verder/db";
import { recordRun } from "../heartbeat";

const model = process.env.OLLAMA_MODEL ?? "qwen2.5:14b";
const base = process.env.OLLAMA_URL ?? "http://localhost:11434";
const { db, pool } = createDb(process.env.WORKER_DATABASE_URL!);
const local = await fetch(`${base}/api/show`, { method: "POST",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) })
  .then((r) => r.json()) as { details?: { parameter_size?: string }; modified_at?: string };
// Pull check: ollama pulls are idempotent — pulling an up-to-date tag is a no-op,
// an updated tag downloads the new weights. Report what happened.
const pull = await fetch(`${base}/api/pull`, { method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model, stream: false }) }).then((r) => r.json()) as { status?: string };
await recordRun(db, "model-check", "ok", { model, localModifiedAt: local.modified_at, pullStatus: pull.status });
console.log(`model-check: ${model} → ${pull.status}`);
await pool.end();
```
Host crontab: `30 3 * * * /path/to/verder/ops/nightly.sh >> /var/log/verder-nightly.log 2>&1`.

- [ ] **Step 4: Write `docs/deploy.md`**

Document, in order: prerequisites (Docker, cloudflared tunnel, Ollama with the chosen model pulled), creating `.env.prod` from `.env.example` + prod extras, first-run sequence (`docker compose -f docker-compose.prod.yml up -d postgres` → migrations as admin → better-auth migrate → role passwords → seed → `up -d`), Gmail one-time auth (`pnpm --filter worker gmail:auth` on the host, token lands in `./secrets`), enabling the crontab line, and the restore procedure (`gunzip < db-DATE.sql.gz | docker compose exec -T postgres psql -U verder verder`, rsync vault back, run verification, confirm green).

- [ ] **Step 5: Verify end-to-end + commit**

On the homelab: bring the stack up, log in through the tunnel URL, log one manual entry, email yourself from a whitelisted address, watch it appear in the queue within ~5 min, approve it, drop a scan in the NAS folder, watch it hit the vault inbox, run Verify → green.

```bash
git add apps ops docker-compose.prod.yml docs/deploy.md && git commit -m "feat: production deployment with nightly backup, verification and model check"
```

---

## Post-plan notes for the executor

- Tasks 1→10 are strictly ordered. Tasks 11–14 depend on 10 but not on each other. Tasks 16–19 depend on 15; 17 depends on 16 (raw emails to suggest on); 20 depends on everything.
- Integration tests assume the dev postgres from Task 1 is up and migrations applied. Tests share one database and never truncate it (append-only!) — that's why every test asserts on rows it created itself, never on global counts. If the dev DB gets messy, `docker compose down -v && docker compose up -d postgres` + re-migrate + re-seed is the reset path.
- After Task 14 the system is fully usable manually — that's the first real milestone for Martin. Ship it to the homelab early (do a provisional Task 20 pass) rather than waiting for the watchers.
- The Figma visual pass over Tasks 10–14's screens is intentionally NOT in this plan; it's a separate cycle with Martin once the functional UI exists.








