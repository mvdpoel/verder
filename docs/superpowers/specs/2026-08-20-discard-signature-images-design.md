# Discarding Junk Documents — Design Spec

**Date:** 2026-08-20
**Status:** Approved design, pending implementation plan
**Scope:** Gmail ingest (sub-project 1), document status, vault/queue/search surfaces

## Purpose

Every email signature logo the mail watcher sees becomes a document in the
vault. Opening `/vault/d17bb55c-…` shows a 633-byte LinkedIn badge sitting in
the evidence record with a Title field, a Type field and a "File it" button,
as though it were a court decision.

Measured in production on 2026-08-20:

```
 9 of 16 email attachments are "image.png"   (633 B – 80 KB)
 7 of 16 are real documents  ("Beschikking M.P. van der Poel.pdf", …)
```

**56% of everything the mail watcher has filed is signature cruft.** That is
noise in the one place Martin needs to be able to trust and scan quickly.

## Root cause

`apps/worker/src/gmail-auth.ts:61-71` promotes **every** message part that has
a filename into a vault document:

```ts
if (p.filename && p.body?.attachmentId) { …ingest… }
```

`Content-Disposition` is never consulted. A signature logo is
`Content-Disposition: inline` carrying a `Content-ID`, referenced from the HTML
body as `cid:…`. A genuine attachment is `Content-Disposition: attachment` and
has no `Content-ID`. The information needed to tell them apart is already in
the part headers the Gmail API returns; it is being discarded.

### Why skipping them loses nothing

`ingestRawEmail` stores the full RFC822 original in the vault before anything
else (`apps/worker/src/gmail.ts:35`). The logo's bytes are inside that message
as base64 and stay verifiable forever. Declining to promote an inline image to
a standalone document removes a row from a list; it removes no evidence.

This is what makes header-based skipping safe where a size or filename
heuristic would not be. "Any small `image.png`" would eventually swallow a real
screenshot of a payment confirmation, silently.

## Scope decisions (approved)

| Decision | Choice |
|---|---|
| Prevention | Skip parts that are `inline` **and** carry a `Content-ID`, at the Gmail port |
| Discard semantics | A new `discarded` value on the existing `doc_status` enum, appended through `document_status_changes` with its ledger event |
| Purge file bytes | **No** — see below |
| "Always discard" mechanism | Nothing new: sha256 dedup already provides it |
| Existing nine | Auto-discarded by a one-time script, one ledger event each, individually undoable |
| Recoverability | Discarded documents stay reachable by direct URL and can be undone |

### Discard cannot mean delete

Evidence tables are append-only at the Postgres-grant level and the document
already carries a `document.ingested` ledger event. Deletion would break the
hash chain — the exact property the vault exists to provide. Discard is
therefore a status change, appended exactly as `filed` is today, and the record
states plainly that Martin discarded it and when.

### Why the bytes are not purged

Purging was considered and rejected on measurement, not principle:

- The nine images total **142,197 bytes against a 12 MB vault** — 1.2%.
- Purging does **not** remove the image. The same bytes remain inside the
  archived `.eml`, so the "deletion" is cosmetic.
- The cost lands in the wrong place. `nightly-verify` currently proves *"18
  files, all matching their hashes"* with no exceptions. Purging would teach
  the one component whose whole job is having no special cases to accept some
  absences as legitimate.

If purge is ever revisited, the safe shape is: the purge appends its own
`document.purged` ledger event, and verify accepts a missing file **only** when
such an event exists for that sha256 — so quietly deleting a vault file is
still a hard failure. Out of scope here.

### "Always" is already free

`ingestDocument` (`packages/api/src/routers/documents.ts:14-16`) dedups on
sha256: re-ingesting identical bytes returns the existing row and appends no
new ledger event. So discarding a document is permanent for those bytes — the
same logo can arrive in a hundred further signatures and stays discarded, with
no rule table and no new concept. The content-addressed vault gives "always
discard" for nothing.

Note the nine `image.png` rows are nine *different* images (different senders,
different logos), not nine copies of one. Prevention handles the general case;
discard handles stragglers.

## Components

### 1. `gmail-auth.ts` — skip inline body images

The `walk` function reads each part's headers and skips a part when its
`Content-Disposition` is `inline` **and** it has a `Content-ID`. Both
conditions are required: an inline part without a `Content-ID` is not a `cid:`
body reference and is kept.

The decision is lifted into a pure, exported helper so it is testable without
the Gmail API:

```ts
isInlineBodyImage(headers: Record<string, string>): boolean
```

Header lookup is case-insensitive — `Content-ID`, `Content-Id` and
`content-id` all occur in the wild.

### 2. `discarded` document status

`docStatusEnum` (`packages/db/src/schema.ts:8`) gains `"discarded"`. Migration
0021, additive `ALTER TYPE ... ADD VALUE`, identical in shape to 0020 and
carrying the same deploy-ordering requirement: **migrate from the homelab host
before the new images go up**, or discarding fails on the enum after the
document and its ledger event are already written.

Discard and undo both go through the existing status-change path, so
`effectiveDocument` resolves them with no change. No new table, no new ledger
event type.

### 3. Hiding discarded documents

| Surface | Change |
|---|---|
| `documents.list` | Excludes `discarded` unless `includeDiscarded: true`. Affects the vault page and the registry/debt evidence pickers, which call it with no status filter |
| Search | `AND c.status IS DISTINCT FROM 'discarded'` in `retrieve.ts:178`. One column comparison, no subquery |
| Queue | `suggestions.list` drops suggestions whose linked document is discarded |

**Search freshness needs no new plumbing — verified, not assumed.**
`document_status_changes` already carries a `search_outbox` trigger
(`0017_search_triggers.sql`, `search_enqueue('document', 'document_id')`), so
appending a discard status change enqueues a reindex of that document, and the
`search.drain` job every 60 s rewrites `search_chunks.status` to `discarded`.
The filter then hides it. Discarding is search-consistent within a minute with
no code beyond the `WHERE` clause.

### 4. UI

A **Discard** button beside "File it" on the vault detail page, and **Undo
discard** on an already-discarded document, which also shows a plain banner
saying it is discarded. Discarded documents remain reachable by direct URL.

### 5. Backfill

A one-time, idempotent script marks the existing nine as discarded, each
appending its own status change and ledger event so the audit trail shows
exactly what happened and when, and each individually undoable.

It selects `source = 'email-attachment' AND title = 'image.png'` and skips any
document already discarded. Post-hoc the disposition header is gone, so the
title is the honest available key; it happens to match all nine exactly. The
script prints every document it will touch before touching it.

## Error handling

- A part with malformed or absent headers is **kept**, never skipped. The
  failure mode of over-ingesting is noise; the failure mode of over-skipping is
  lost evidence, and only one of those is recoverable.
- Discarding an already-discarded document is a no-op, not an error.
- The backfill is idempotent: re-running it appends nothing.

## Testing

- `isInlineBodyImage`: inline + `Content-ID` → skipped; `attachment` → kept;
  inline without `Content-ID` → kept; missing headers → kept; mixed-case header
  names → handled.
- `ingestRawEmail`: a message carrying one signature logo and one real PDF
  ingests exactly one document, and the raw `.eml` is still stored.
- Discard and undo each append a status change and a ledger event, and the hash
  chain still verifies afterwards.
- `documents.list` excludes discarded by default and includes them on request.
- Search excludes discarded chunks; a non-discarded document with the same
  query still ranks as before.
- `suggestions.list` omits suggestions whose document is discarded.
- Backfill: selects exactly the nine, is idempotent on a second run, and
  appends one ledger event per document.

## Out of scope

- Purging vault bytes (see above).
- Any size- or filename-based auto-discard heuristic. The disposition header is
  the correct discriminator; guessing from size would eventually discard real
  evidence.
- Bulk discard from the vault list, and a "discarded" browsing view. Direct URL
  is enough at nine documents.
- Retroactively removing already-indexed discarded chunks from `search_chunks`
  beyond what the status filter hides; `reindex` already re-resolves status.
