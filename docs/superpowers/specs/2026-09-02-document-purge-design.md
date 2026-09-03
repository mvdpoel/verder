# Definitief verwijderen — destroying a document's bytes without breaking the ledger

Date: 2026-09-02
Status: design, approved shape, not yet implemented
Sub-project: 11 (files)

## The ask

A delete button on the file detail page (`/files/[id]`). Not the existing
`Wegleggen`, which hides a document and keeps everything: a real delete, where
the bytes leave the disk.

## Why this cannot be a plain DELETE

Three findings from reading the code, each of which rules out the obvious
implementation.

**1. `/verify` re-derives every `document.ingested` event from the live row and
the live bytes.** `packages/api/src/verification.ts:258-266`:

```ts
const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, e.entityId));
if (!doc) return "missing-document-row".padEnd(64, "0");
try {
  const buf = await readFile(readFilePath(vaultDir, doc.sha256));
  return sha256Hex(buf) === doc.sha256 ? e.payloadHash : "file-hash-mismatch".padEnd(64, "0");
} catch { return "file-missing".padEnd(64, "0"); }
```

The `document.ingested` event is in the hash chain and can never be removed. So
deleting the row or the bytes leaves one permanently failing seq, reported by
`nightly-verify` every night forever. Tolerating it would teach the one surface
that proves the dossier is intact that some failures are fine — which is the
same objection CLAUDE.md already records against purging discarded documents.

**2. A document cited by a logbook entry is worse than that.**
`entryEventPayload` includes `documentIds`, so removing an `entry_documents`
row changes a ledgered *entry's* recomputed payload hash. That surfaces as
`payload_hash_mismatch` on the entry — indistinguishable from someone having
tampered with the logbook.

**3. The grants are the law's teeth.** `documents` and `entry_documents` are
`SELECT, INSERT` only for both application roles (`0001_grants.sql:13`), and
ten tables carry an FK to `documents.id`: `document_status_changes`,
`entry_documents`, `suggestions`, `debt_documents`, `registry_decisions`,
`tasks`, `timeline_events`, `stops`, `document_texts`, `bundle_documents`.

## The shape

**Purge the content, keep the row.** The `documents` row survives as a
tombstone — it is the ledger's anchor and it names what was destroyed. What
actually gets destroyed is everything that carries the document's *content*:

- the vault file (`vault-files/ab/cd/<sha256>`)
- the extracted text (`document_texts`)
- the search chunks (`search_chunks` for that entity)

The deletion is itself evidence: one `document_purges` row and one
`document.purged` ledger event, and `/verify` learns to verify a purged
document against that record instead of against bytes that are gone on purpose.

Every ledgered citation stays intact — `entry_documents`, `debt_documents`,
`registry_decisions`, `stops`, `tasks` are untouched — so no other event's
payload changes. That is the property that makes this shape work and the
row-delete shape not work.

Irreversible by construction: there is no undo, and the same bytes can never be
re-ingested, because `documents.sha256` is `UNIQUE` and `ingestDocument` dedups
on it. That is the rule discard already has ("a discarded document stays
discarded for those bytes forever"), applied to a stronger action.

### Not a fourth `doc_status`

A `purged` value in the `doc_status` enum, appended through
`document_status_changes`, was considered and rejected. It would either need
its own `document.updated` event (two ledger events for one action, saying
overlapping things) or a status-change row with no matching event — and an
unmatched row is exactly what `resolveDocumentUpdatedHashes` consumes when it
looks for one, so a stray row could later vouch for an event it has nothing to
do with. `document_purges` as its own table keeps the two mechanisms apart.

## Schema — migration 0034

```sql
CREATE TABLE document_purges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL UNIQUE REFERENCES documents(id),
  sha256       text NOT NULL,
  size_bytes   bigint NOT NULL,
  reason       text,
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON document_purges TO verder_app, verder_worker;
GRANT DELETE ON document_texts, search_chunks TO verder_app;
```

`document_id` is `UNIQUE`: a document is purged once. A second purge is a
no-op, not an error — the same law `documents.update` follows for a repeated
discard, and for the same reason (one decision must not appear in the record
twice).

`sha256` and `size_bytes` are copied rather than read back off `documents`.
They are the record of *what was destroyed*, and it should not depend on
another table still saying the same thing.

`reason` is nullable — the button offers the field and does not demand it.

`document_purges` is an evidence table: `SELECT, INSERT`, no UPDATE, no DELETE.

**The one grant widening, and why it is lawful.** `verder_app` holds `SELECT`
only on `document_texts` and `search_chunks` (`0016_search_grants.sql`,
deliberately: "the web app searches the index and never maintains it"). Without
`DELETE` there, a purge leaves the document's full OCR'd text in the database
and in search, and the button is a lie. Both tables are DERIVED and already
documented as non-evidence — "they hold no facts: only a rebuildable lookup",
with `DELETE` already granted to `verder_worker`. Widening the app's grant on
two rebuildable tables is not the same act as widening it on `documents`.

## The mutation

`documents.purge({ id, reason? })`, `protectedProcedure`.

```
transaction:
  advisory lock on hashtextextended(id)        -- same serialisation as update
  load document; NOT_FOUND if absent
  if already purged: return the existing tombstone (no-op, no second event)
  insert document_purges { documentId, sha256, sizeBytes, reason, createdBy: ctx.userId }
  appendLedgerEvent document.purged
  delete document_texts where document_id = id
  delete search_chunks where entity_type = 'document' and entity_id = id
commit
then: unlink the vault file
```

**The unlink is after the commit, and that ordering is not interchangeable.**
`unlink` is not transactional. Inside the transaction, a rollback after a
successful unlink destroys the bytes with no record of it — the worst outcome
this design exists to prevent, and permanently red on `/verify` with nothing
explaining why. After the commit, the failure mode is the harmless one: a purge
record whose bytes are still on disk, which is detectable and repairable.

**The leftover is detected, not assumed away.** `/verify`'s purged branch
`stat`s the path (it no longer reads it) and counts what is still there;
`documents.get` returns `purge.bytesStillOnDisk` so the tombstone can offer a
"probeer opnieuw te verwijderen" button. Without those, a failed unlink is
silent and permanent.

## Verification

Two changes in `packages/api/src/verification.ts`.

**`document.ingested`** — before reading the file, look for a purge:

```ts
if (purge) return purge.sha256 === doc.sha256 ? e.payloadHash : "purge-sha-mismatch"…
```

Deleting the `document_purges` row therefore does not launder a deletion: the
branch falls through to the file read and reports `file-missing`, exactly as it
does today.

**`document.purged`** — recomputed from the live `document_purges` row, the
established pattern of `registryDecisionPayloadHash` and
`taskStatusPayloadHash`. Editing a stored reason surfaces as
`payload_hash_mismatch` at that seq.

**`FullVerificationResult` gains `purgedFiles` and `purgedFilesOnDisk`.** A
purged document is not counted in `checkedFiles` — it is not a file that was
checked. `/verify` must *show* the deletions ("75 bestanden gecontroleerd, 2
definitief verwijderd"), because a design where files can vanish without the
verification page saying so is the hole this whole spec is avoiding.

## The four places that must learn about purged

`notPurgedSql` joins `notDiscardedSql` in `packages/api/src/effective-status.ts`:

```sql
NOT EXISTS (SELECT 1 FROM document_purges p WHERE p.document_id = documents.id)
```

1. **`pendingDocMeta`** (`apps/worker/src/docmeta-sweep.ts`) — **this one is a
   loop, not a cosmetic miss.** It selects documents with no `document_texts`
   row, and the purge deletes exactly that row. Without `notPurgedSql` the
   purged document is pending forever and the sweep sends it to OCR a file that
   no longer exists, every hour, on the shared GPU. The sweep's documented
   convergence argument ("storeDocumentText writes a row for EVERY attempt")
   does not cover a row that was deleted afterwards.

2. **`indexEntity`'s `document` case** — a purged document deletes its chunks
   and creates none. Without this, `reindex` walks every document and rebuilds
   a chunk from the title and metadata, resurrecting the purged document into
   `/search` under its own name.

3. **`documents.list` and `documents.browse`/`tree`** — purged documents leave
   the normal branches, and the `status` branch gains a `purged` value listing
   the tombstones. They stay reachable: a record of what was destroyed that can
   only be found by typing a UUID is not a record, which is the same reasoning
   that put the collapsed "Weggelegd" section on the old vault page.

4. **`/api/files/[sha256]` and the zip route** — a purged document answers
   `410 Gone` naming it, never a silently short archive. The zip already reads
   every file before writing a byte and returns `409` on a missing one; this
   makes the message truthful about *why* it is missing.

## UI

**`/files/[id]`, not purged.** A third zone in `DocumentMetaForm`, below a
hairline, under the entry-link block. Two-step, the shape `BundleCard` already
uses: a ghost `Definitief verwijderen` reveals an optional `Reden` input and a
`danger` `Ja, definitief verwijderen` beside a `quiet` `Annuleren`. `danger`,
not `signal`, for the reason `BundleCardActions` already records — bordered
amber is the system's voice for "something you only want to do on purpose",
while `signal` reads as "this is the one to press". The mutation is `reset()`
when the confirm opens, so a failed attempt does not show its error over the
next one. Available on any document regardless of status.

**`/files/[id]`, purged.** The page renders a tombstone: the preview panel is
replaced by a notice — `Definitief verwijderd op <datum>`, the reason if there
is one, the sha256, and what the file was (title, soort, grootte). The meta
form is gone; there is nothing left to edit and no way back. If
`bytesStillOnDisk`, one amber line and a retry button — that is a real unfinished
action waiting on somebody, which is what amber is for.

Dutch, like every other label in the app.

## Testing

Written first, and the sixth and seventh are the ones that would otherwise ship
broken:

1. Purge writes one `document_purges` row and exactly one ledger event, unlinks
   the file, and deletes `document_texts` + `search_chunks`.
2. A second purge appends nothing and returns the existing tombstone.
3. `/verify` is `ok` after a purge; `checkedFiles` drops by one and
   `purgedFiles` is 1.
4. Tamper: editing the purge reason → `payload_hash_mismatch` at that seq.
5. Tamper: deleting the purge row → `file-missing` at the ingested seq (a purge
   cannot be laundered by removing its record).
6. `pendingDocMeta` does not return a purged document.
7. `indexEntity` on a purged document leaves zero chunks, and a second call
   creates none.
8. `documents.list` and every `browse` branch exclude it; the `purged` status
   branch returns it.
9. **Purging a document linked to a logbook entry leaves `/verify` green** —
   the `entry_documents` row survives, so the entry's payload is unchanged.
   This is the property that chose this shape over a row delete, and it should
   fail loudly if anyone ever adds the cascade.

## Deploy

The same ordering trap as 0020–0033, with the usual blast radius:

1. `rsync` first — the migration file does not exist on the homelab until you
   send it. Use the full exclude list from CLAUDE.md, and `--dry-run --info=del`
   first.
2. `pnpm --filter @verder/db migrate` from the homelab **host**, with
   `DATABASE_URL` sourced from `.env.prod` (deploy.md §7.1).
3. Rebuild web + worker.

Between 2 and 3 nothing breaks: the new table is additive and nothing in the
running images reads it.

Expected after deploy, before anyone clicks the button: ledger head
**unchanged**, 140 events, 75 files. The first purge appends exactly one event
and drops `checkedFiles` by one.

## Out of scope

- Any purge path that is not this button (no bulk purge, no rule-driven purge,
  no worker script).
- Purging a `raw_emails` body. The archived `.eml` for a mailed attachment still
  contains the attachment — CLAUDE.md notes this about discard already, and it
  is equally true here. A purge destroys the vault copy and the extracted text;
  it does not claim to have erased every trace of the content from the dossier,
  and the tombstone should not pretend otherwise.

- **The backups.** `ops/nightly.sh` mirrors the vault with `rsync -a` and
  deliberately no `--delete` ("the backup only ever grows"), and the nightly
  dump deliberately keeps `document_texts`. So a restore brings back both the
  bytes and the text of a purged document: **a purge is not a guarantee against
  a restore.** It is the same concession as the archived `.eml` above, one
  layer down.

  It is disclosed rather than assumed away, which is this design's rule
  throughout: `/verify` reports returning bytes (`purgedFilesOnDisk`) and
  returning text or chunks (`purgedContentLeftovers`) on every run, nightly
  included. After ANY restore the purged set must be re-destroyed — purging a
  purged document is idempotent and re-runs the unlink and both DELETEs, so
  clicking the button again is the repair. The restore procedure in
  `docs/deploy.md` carries this as a numbered step.
