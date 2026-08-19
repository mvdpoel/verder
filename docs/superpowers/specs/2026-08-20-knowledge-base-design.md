# Searchable Knowledge Base — Design Spec

**Date:** 2026-08-20
**Status:** Approved design, pending implementation plan
**Sub-project:** 4 of the verder platform

Prior sub-projects:
1. Logbook + vault — `docs/superpowers/specs/2026-08-18-logbook-vault-design.md` (shipped 2026-08-18)
2. Financial registry — `docs/superpowers/specs/2026-08-18-financial-registry-design.md` (shipped 2026-08-19)
3. Tasks + milestones — `docs/superpowers/specs/2026-08-19-tasks-milestones-design.md` (shipped 2026-08-19)

## Purpose

Nothing in this application is searchable. There is no full-text index, no
embeddings, no search box on any screen. The worker already extracts text from
every vault document — `extractText` in `apps/worker/src/index.ts` parses PDFs
and OCRs images — and then throws that text away after a single suggestion call.
Every scanned letter Martin owns is a blob with a filename.

This sub-project makes the whole application findable, for Martin and for the
agent, using one hybrid index: Postgres full-text plus pgvector embeddings,
fused by reciprocal rank, with an LLM rerank pass where latency is affordable.
It is the remaining piece of the braindump's pillar 3 ("memory architecture:
RAG with reranking") and the precondition for the agent ever answering "do we
already have this document?" with evidence instead of a guess.

## Scope decisions (approved)

| Decision | Choice |
|---|---|
| Primary user | **Both** Martin (search UI) and the agent (retrieval API), tuned equally |
| Corpus | **Everything**: documents, log entries, raw emails, financial items, debts, tasks, milestones, timeline events, parties |
| Ranking | **Hybrid** full-text + vector, RRF-fused; LLM rerank on the agent path only (fast path stays instant) |
| Agent payoff | **Both** "do we already have this?" on queue cards **and** retrieval citations on suggestions |
| Search UI | **⌘K palette + `/search` results page** |
| Index regime | **Derived, not evidence** — rebuildable, UPDATE/DELETE allowed, no ledger events |
| Freshness | **Trigger outbox** on source tables, drained by a worker job |
| Storage | One Postgres (`pgvector/pgvector:pg17`) — no second datastore |

### Why the index is not evidence

The project law says evidence tables are append-only and every evidence mutation
appends a `ledger_events` row. `search_chunks` and `document_texts` hold no
facts — they hold a derived lookup *for* facts that live in the evidence tables.
They are fully rebuildable from source records by `reindex`. Therefore they
allow UPDATE and DELETE and append no ledger events. This weakens nothing: a
tampered index cannot corrupt the record, it can only fail to find it, and index
health is surfaced on `/verify` so that failure is visible.

## Data model

### `document_texts` (derived)

One row per vault document; OCR and PDF parsing run once per file, ever.

```
document_id   uuid pk → documents.id
sha256        text not null      -- vault bytes this text came from (staleness check)
text          text not null      -- capped at 1 MB
extractor     text not null      -- 'pdf-parse' | 'ocr-image' | 'ocr-pdf' | 'none'
char_count    integer not null
extracted_at  timestamptz not null default now()
```

### `search_chunks` (derived)

```
id            uuid pk
entity_type   text not null   -- document | entry | email | financial_item | debt
                              -- | task | milestone | timeline_event | party
entity_id     uuid not null
chunk_index   integer not null
title         text not null   -- denormalized: results render without joins
body          text not null
occurred_at   timestamptz     -- date filters + recency tie-break
tsv           tsvector generated always as
                (to_tsvector('dutch', title || ' ' || body)) stored
embedding     vector(768)     -- nomic-embed-text; NULL when embedding failed
source_hash   text not null   -- hash of title+body; unchanged text is never re-embedded
embed_attempts integer not null default 0
indexed_at    timestamptz not null default now()
unique (entity_type, entity_id, chunk_index)
```

Indexes: GIN on `tsv`, HNSW cosine on `embedding`, btree on `entity_type`,
btree on `occurred_at`.

### `search_outbox` (derived)

```
id            bigserial pk
entity_type   text not null
entity_id     uuid not null
enqueued_at   timestamptz not null default now()
```

## Freshness: trigger outbox

An `AFTER INSERT OR UPDATE` trigger on each of the nine source tables writes
`(entity_type, entity_id)` to `search_outbox`. A worker job (`search.drain`,
every 60 s) dedupes the outbox, re-renders and re-chunks each entity, re-embeds
only chunks whose `source_hash` changed, upserts, and deletes the drained rows.

Chosen over calling an enqueue helper at each mutation site: there are dozens of
such sites across four routers and the worker, and a forgotten one is an
invisible bug — a record that silently never becomes findable. The trigger
catches writes from any path, including manual `psql`. The trigger function is
`SECURITY DEFINER` so `verder_app` and `verder_worker` need no direct grants on
the outbox.

Records in this application are never deleted, so the drain handles insert and
update only; `reindex --prune` removes orphan chunks if that ever changes.

## Text extraction

- **PDF** → `pdf-parse`.
- **Image** → `tesseract.js` (`nld+eng`), as today.
- **Scanned PDF** → the NAS scanner produces PDFs that are images in a PDF
  wrapper; `pdf-parse` returns near-empty text and `tesseract.js` cannot open a
  PDF. Any PDF parsing to under 200 characters is rasterized with `poppler-utils`
  (`pdftoppm`, 200 DPI, first 20 pages) and OCR'd, recorded as `ocr-pdf`. The
  worker image gains `poppler-utils`. Skipping this would ship a search that
  cannot find most of Martin's actual mail.
- Extraction is keyed by `sha256`: content-addressed vault files are never
  re-extracted.

## Chunking and rendering

- **Documents**: ~1200 characters with 150 overlap, split on paragraph
  boundaries.
- **Short structured records**: a single chunk from a Dutch rendering template
  per entity type — e.g. an item renders as `Naam: Ziggo. Categorie: telecom.
  Status: to-cancel. Toelichting: …` — so one query hits prose and structured
  records alike.
- **Raw emails**: subject + body text, quoted-reply tails stripped.

## Query pipeline

Input: query string, filters (`entityTypes[]`, date range, `partyId`, status),
limit, mode (`fast` | `deep`).

1. Filters apply as SQL `WHERE` before fusion. When filters are present,
   `ef_search` is raised so HNSW recall does not collapse on a narrow slice.
2. **Lexical**: `websearch_to_tsquery('dutch', q)`, ranked by `ts_rank_cd`,
   top 50.
3. **Semantic**: query embedded with nomic's `search_query:` prefix (chunks are
   embedded with `search_document:`), cosine ANN, top 50.
4. **Fusion**: reciprocal rank fusion, `Σ 1/(60 + rank)`. Results collapse to
   the best chunk per entity so one long document cannot fill the page with its
   own chunks.
5. **`fast`** returns here — ⌘K and `/search`. Target under 300 ms warm.
6. **`deep`** reranks the top 20 via Ollama (prompt `rerank-v1`, versioned and
   recorded like every other prompt), 20 s timeout, **falling back to the fused
   order on timeout**. Search may degrade; it may not error.

## Agent surfaces

### "Do we already have this?"

`clarityEnum` already carries `already-provided`, and action-item mining can
emit it — but the model has no way to know whether something was actually
provided, so today it guesses. When a suggestion carries a document request, the
queue card runs `deep` retrieval on the request text and shows the top 3 vault
documents with matched snippet and score, plus one-click linking of that
document to the entry or task. No email is sent or drafted in this sub-project.

### Retrieval citations on suggestions

When the worker builds a suggestion it retrieves against the source email and
stores the references on a **new `retrieved_refs` jsonb column** on
`suggestions`, rendered on the queue card as what the model saw.

Deliberately *not* inside `proposed`: `proposed` is diffed against
`final_payload` to record Martin's edits per the golden rule, and retrieval
context in that column would corrupt every edit diff with noise.

## Screens

- **⌘K palette** — mounted in the app layout; 150 ms debounce; fast mode capped
  at 8 hits grouped by record type; arrow-key navigation; Enter opens the
  record; ⇧Enter or "see all" goes to `/search?q=`; empty state lists recent
  records.
- **`/search`** — server-rendered from the query param, so a bookmarked or
  shared search URL renders without JS. Filter rail (type, date range, party,
  status); snippets via `ts_headline('dutch', …)` for keyword hits and the chunk
  head for semantic-only hits; a **keyword / semantic / both** badge per result
  making it visible *why* something matched; cursor pagination.
- **`/verify`** — gains index health: chunk count, outbox depth, embedding
  failures, last drain time, so a stalled index is visible beside the ledger
  checks.
- **`/queue`** — document-request cards gain the "we may already have this"
  panel; all suggestion cards gain the citations list.

## Error handling

- **Ollama down** → embeddings stay NULL, chunks remain searchable by full text,
  `/search` shows an honest "semantic search unavailable" note. Failed chunks
  increment `embed_attempts` and are retried by the next drain.
- **Rerank timeout** → fused order, logged.
- **Backfill** → `pnpm --filter worker reindex [--entity=…] [--since=…]`,
  batched, idempotent by `source_hash`, safe to interrupt and rerun, progress
  recorded in `worker_runs`.
- **Extraction failure** → recorded as extractor `none` with the error in
  `worker_runs`; the document stays findable by title and metadata.
- **Oversized text** → capped at 1 MB, truncation flagged.

## Deployment

- Postgres image swaps from `postgres:17` to `pgvector/pgvector:pg17` in dev and
  prod. Same PG 17 major, so the data volume is compatible: it is a container
  replace plus `CREATE EXTENSION vector`. Because it is a production database
  container change, it gets its own deploy step with a fresh backup taken first
  and a verified `nightly-verify` afterwards.
- Backfill is GPU-bound on the homelab and run off-peak, resumable, never
  claimed to be instant.
- Nightly backup excludes `search_chunks` data (`--exclude-table-data`) — it
  will be the largest table and is fully derived. The documented restore
  procedure in `docs/deploy.md` gains an explicit `reindex` step so a restored
  system is rebuilt rather than mysteriously empty.

## Testing

- **Unit**: chunk boundaries, overlap and unicode; per-type rendering templates;
  RRF fusion math; `source_hash` skip logic; quoted-reply stripping.
- **Integration** (pgvector test database): the trigger fires for all nine
  source tables and the drain indexes them; Dutch stemming (`opzegging` finds
  `opzeggen`); filters pre-filter correctly; one document cannot dominate
  results; Ollama-down returns lexical results; rerank timeout returns fused
  order.
- **Web**: `/search` renders server-side with JS disabled; palette keyboard
  navigation.
- **Ledger**: the existing verifier suite must stay green — this sub-project
  appends no ledger events, and a test asserts that indexing writes none.
- **Retrieval eval** (golden rule): `pnpm --filter worker retrieval-eval`, ~15
  Dutch query→expected-record pairs (dossier number, paraphrase
  `opzeggen`/`beëindiging`, scanned-letter query, plus negatives that must
  return nothing), scored by recall@5 and MRR, `fast` and `deep` measured
  separately so the rerank's actual value is visible. Baseline recorded as an
  honest range over three runs, like the existing three evals.

## Out of scope

- The markdown wiki / OKF format and a separate graph database (the braindump's
  other memory ideas — this slice proves hybrid retrieval first).
- Drafting or sending replies, and attaching documents to outbound mail
  (sub-project 5, the proactive agent).
- The structured personal-facts record (household, employment, income).
- Multi-user permission filtering of search results.
- Bank/PSD2 connections, cancellation execution, and everything already listed
  out of scope by sub-projects 1–3.
