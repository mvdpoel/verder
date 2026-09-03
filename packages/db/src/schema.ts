import { sql } from "drizzle-orm";
import { bigint, bigserial, boolean, check, customType, date, index, integer, jsonb, pgEnum, pgTable, text, timestamp, unique, uniqueIndex, uuid, vector } from "drizzle-orm/pg-core";

export const channelEnum = pgEnum("channel", ["call", "meeting", "email", "whatsapp", "voicemail", "letter", "other"]);
export const directionEnum = pgEnum("direction", ["inbound", "outbound", "internal"]);
export const entrySourceEnum = pgEnum("entry_source", ["manual", "gmail-watch", "nas-watch"]);
export const docSourceEnum = pgEnum("doc_source", ["upload", "nas-scan", "email-attachment"]);
export const docStatusEnum = pgEnum("doc_status", ["inbox", "filed", "discarded"]);
export const partyKindEnum = pgEnum("party_kind", ["person", "organization"]);
export const clarityEnum = pgEnum("clarity", ["clear", "ambiguous", "already-provided"]);
export const actionStatusEnum = pgEnum("action_status", ["open", "done", "cancelled"]);
export const suggestionKindEnum = pgEnum("suggestion_kind", ["log-entry", "document-meta", "registry-item", "debt", "task"]);
export const suggestionStatusEnum = pgEnum("suggestion_status", ["pending", "approved", "edited", "rejected", "needs-manual"]);

// --- financial registry (sub-project 2) ---
export const itemCategoryEnum = pgEnum("item_category", ["energy", "insurance", "telecom", "streaming", "software", "housing", "other"]);
export const billingCycleEnum = pgEnum("billing_cycle", ["monthly", "quarterly", "yearly", "irregular"]);
export const paymentChannelEnum = pgEnum("payment_channel", ["direct-debit", "paypal", "apple", "invoice"]);
export const discoverySourceEnum = pgEnum("discovery_source", ["manual", "bank", "paypal", "apple", "email"]);
export const itemStatusEnum = pgEnum("item_status", ["identified", "mandatory", "allowed", "requested", "to-cancel", "canceled"]);
export const debtStatusEnum = pgEnum("debt_status", ["identified", "acknowledged", "disputed", "in-settlement", "settled"]);
export const txSourceEnum = pgEnum("tx_source", ["abn-camt053", "abn-tsv", "paypal-csv", "abn-xls"]);

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
  // A contact person is a `person` whose parent is the `organization`. Reusing
  // parties rather than a contacts table has a payoff: pollGmail builds its
  // relevance filter from parties.email, so recording a contact person's
  // address makes their mail start being ingested.
  parentPartyId: uuid("parent_party_id"),
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
  // The sender, resolved at INGEST and never updated: verder_app and
  // verder_worker hold SELECT, INSERT on this table and no UPDATE, which is
  // the append-only law. A correction rides document_status_changes.party_id
  // and is resolved by effectiveDocument, exactly as title and docType are.
  partyId: uuid("party_id").references(() => parties.id),
});

export const documentStatusChanges = pgTable("document_status_changes", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id").notNull().references(() => documents.id),
  status: docStatusEnum("status").notNull(),
  title: text("title"),
  docType: text("doc_type"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  partyId: uuid("party_id").references(() => parties.id),
});

/**
 * A destroyed document's obituary. EVIDENCE: SELECT, INSERT only.
 *
 * The `documents` row it points at SURVIVES — it anchors the document.ingested
 * event, which can never leave the hash chain. What a purge destroys is the
 * content: the vault file, the extracted text and the search chunks. Every
 * ledgered citation (entry_documents, debt_documents, registry_decisions,
 * stops, tasks) is deliberately left intact, so no other event's payload
 * changes.
 *
 * NOT a fourth doc_status. A `purged` value appended through
 * document_status_changes would need either its own document.updated event
 * (two events for one action) or a status row with no event — and an unmatched
 * row is exactly what resolveDocumentUpdatedHashes consumes when it looks for
 * one, so a stray row could later vouch for an event it has nothing to do with.
 */
export const documentPurges = pgTable("document_purges", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id").notNull().unique().references(() => documents.id),
  // Copied rather than joined: the record of what was destroyed must not
  // depend on another table still saying the same thing.
  sha256: text("sha256").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  reason: text("reason"),
  createdBy: uuid("created_by").notNull().references(() => users.id),
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
  // Transactional-outbox marker: set once the suggest.entry job for this email
  // has been enqueued. NULL means the ingest committed but the enqueue is still
  // owed — the gmail poller retries it on the next cycle.
  suggestQueuedAt: timestamp("suggest_queued_at", { withTimezone: true }),
  // Which port ingested this message. Defaulted to 'gmail' so every historical
  // row is labelled without its gmail_message_id being touched — that id is
  // also documents.source_ref and the case map's third level derives from it.
  source: text("source").notNull().default("gmail"),
  // The RFC 5322 Message-ID, as the originating server wrote it. This is the
  // only identity that spans the two ingest namespaces: a Stalwart Email id is
  // not a Gmail message id, and Takeout's mbox bytes are not the bytes Gmail's
  // API returned for the same message, so neither gmail_message_id nor
  // raw_rfc822_sha256 recognises a mail the dossier already holds — measured at
  // 130 relevant messages matching 0 of 107 existing rows.
  // NULLABLE, and it has to be: every row predating this column has none until
  // the backfill runs, and a message carrying no Message-ID header at all is
  // unusual but legal. NOT NULL would make the column say something false in
  // both cases; NULL says "unknown", which is the truth.
  messageId: text("message_id"),
}, (t) => [
  check("raw_emails_source_check", sql`${t.source} IN ('gmail', 'jmap')`),
  // The JMAP poller dedups on message CONTENT before ingesting, one lookup by
  // this hash per downloaded message. Unindexed that is a sequential scan per
  // message over a table that is growing by one row per message — O(N^2) on
  // exactly the run this dedup exists for, the first sync after the 11.49 GB
  // Takeout import. NOT unique: the same bytes legitimately arrive twice (one
  // mail delivered to two addresses, a Takeout copy of something Gmail already
  // ingested) and the poller's answer is to skip the second, not to have
  // Postgres abort the sync.
  index("raw_emails_sha256_idx").on(t.rawRfc822Sha256),
  // One lookup by Message-ID per candidate message, on the same sync and for
  // the same reason as the hash index above — and NOT unique for a stronger
  // reason than that one. The poller's policy for a duplicate is to skip it; a
  // unique constraint makes Postgres abort the INSERT instead, would fail the
  // backfill outright the moment two existing rows turn out to share an id, and
  // would promote a malformed sender reusing a Message-ID from a skipped
  // message into an error that stops ingestion.
  index("raw_emails_message_id_idx").on(t.messageId),
]);

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
  // What retrieval put in front of the model when this suggestion was built.
  // Deliberately NOT inside `proposed`: `proposed` is diffed against
  // `final_payload` to record Martin's edits (golden rule), and retrieval
  // context in that column would make every diff noisy and untruthful.
  retrievedRefs: jsonb("retrieved_refs"),
  resultEntryId: uuid("result_entry_id"),
  verdictAt: timestamp("verdict_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- financial registry tables ---
// Editable fact tables (financial_items, debts, transactions): a typo is a
// typo — UPDATE allowed, DELETE never (enforced by grants).
// registry_decisions is an EVIDENCE table: insert-only, ledger-backed.

export const financialItems = pgTable("financial_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  category: itemCategoryEnum("category").notNull(),
  providerPartyId: uuid("provider_party_id").references(() => parties.id),
  amountCents: integer("amount_cents").notNull(),
  billingCycle: billingCycleEnum("billing_cycle").notNull(),
  paymentChannel: paymentChannelEnum("payment_channel").notNull(),
  contractStart: date("contract_start"),
  contractEnd: date("contract_end"),
  noticePeriod: text("notice_period"),
  cancellationMethod: text("cancellation_method"),
  cancellationDetails: text("cancellation_details"),
  accountNumber: text("account_number"),
  discoveredVia: discoverySourceEnum("discovered_via").notNull().default("manual"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const debts = pgTable("debts", {
  id: uuid("id").primaryKey().defaultRandom(),
  creditorPartyId: uuid("creditor_party_id").references(() => parties.id),
  creditorName: text("creditor_name").notNull(),
  principalCents: integer("principal_cents"),
  claimedCents: integer("claimed_cents"),
  references_: text("references"),
  origin: text("origin"),
  originStory: text("origin_story"),
  // Whether Verder knows. NOT a status: it is orthogonal to
  // identified→acknowledged→disputed→…, since a debt can be disputed and
  // reported, or acknowledged and not. The entry link means "Verder knows" is
  // always answerable with "here is the message that told them".
  reportedToVerderAt: timestamp("reported_to_verder_at", { withTimezone: true }),
  reportedViaEntryId: uuid("reported_via_entry_id").references(() => logEntries.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const debtPartyRoleEnum = pgEnum("debt_party_role",
  ["eiser", "incasso", "deurwaarder", "gemachtigde"]);

// The edge `debts` never had. `eiser` is who the money is owed to; the other
// three are who is acting for them. Not constrained to one eiser per debt: a
// notice naming two claimants is a real thing, and refusing to record it would
// lose the notice rather than the confusion.
export const debtParties = pgTable("debt_parties", {
  debtId: uuid("debt_id").notNull().references(() => debts.id),
  partyId: uuid("party_id").notNull().references(() => parties.id),
  role: debtPartyRoleEnum("role").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("debt_party_uq").on(t.debtId, t.partyId, t.role)]);

// Mirrors entry_documents. Until now a document could only hang off a DECISION,
// so the sommation that arrived before any decision had nowhere to go.
export const debtDocuments = pgTable("debt_documents", {
  debtId: uuid("debt_id").notNull().references(() => debts.id),
  documentId: uuid("document_id").notNull().references(() => documents.id),
}, (t) => [unique("debt_document_uq").on(t.debtId, t.documentId)]);

export const transactions = pgTable("transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: txSourceEnum("source").notNull(),
  bookedAt: timestamp("booked_at", { withTimezone: true }).notNull(),
  amountCents: integer("amount_cents").notNull(), // signed: debits negative
  counterpartyName: text("counterparty_name"),
  counterpartyIban: text("counterparty_iban"),
  description: text("description"),
  mandateId: text("mandate_id"),
  // Which account the statement belongs to — NOT the counterparty. Under
  // bewind the same person's money moves between a beheerrekening and a
  // leefgeldrekening; charting them as one stream draws a collapse that
  // never happened. NULL means the export did not reveal it (PayPal).
  accountIban: text("account_iban"),
  statementSha256: text("statement_sha256").notNull(),
  rowIndex: integer("row_index").notNull(),
  parseError: boolean("parse_error").notNull().default(false),
  rawRow: text("raw_row"),
  financialItemId: uuid("financial_item_id").references(() => financialItems.id),
}, (t) => [uniqueIndex("tx_stmt_row_uq").on(t.statementSha256, t.rowIndex)]);

export const registryDecisions = pgTable("registry_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  financialItemId: uuid("financial_item_id").references(() => financialItems.id),
  debtId: uuid("debt_id").references(() => debts.id),
  status: text("status").notNull(),
  explanation: text("explanation").notNull(),
  documentId: uuid("document_id").references(() => documents.id),
  blockerNote: text("blocker_note"),
  overrideReason: text("override_reason"),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("registry_decision_target_ck", sql`num_nonnulls(${t.financialItemId}, ${t.debtId}) = 1`),
]);

// --- tasks (sub-project 3) ---
// tasks is an editable fact table (UPDATE allowed, DELETE never).
// task_status_changes is an EVIDENCE table: insert-only, ledger-backed
// (eventType "task.status", entityType "task_status_change").

// Still live: `stops.stage` uses it. The `milestones` table it was written for
// is dropped by migration 0026, but dropping an enum a live column depends on
// means recreating the type for no gain.
export const wsnpStageEnum = pgEnum("wsnp_stage", ["application", "accepted", "onboarding", "wsnp-start", "settlement", "clean-slate"]);

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  details: text("details"),
  assigneePartyId: uuid("assignee_party_id").references(() => parties.id),
  dueAt: timestamp("due_at", { withTimezone: true }),
  entryId: uuid("entry_id").references(() => logEntries.id),
  financialItemId: uuid("financial_item_id").references(() => financialItems.id),
  debtId: uuid("debt_id").references(() => debts.id),
  documentId: uuid("document_id").references(() => documents.id),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const taskStatusChanges = pgTable("task_status_changes", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id").notNull().references(() => tasks.id),
  status: text("status").notNull(),
  note: text("note"),
  overrideReason: text("override_reason"),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Curated key events: Martin's hand-picked story of the process (intake,
// request sent to court, a call, a letter that arrived). Editable display aid
// — NOT ledgered; linked logbook entries and documents remain the evidence.
// Retired by tracks + stops (sub-project 6); the table is still here because it
// holds rows and dropping it is a separate decision from dropping milestones.
export const timelineEventKindEnum = pgEnum("timeline_event_kind", ["process", "mail", "call", "meeting", "document", "other"]);

export const timelineEvents = pgTable("timeline_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  happenedAt: timestamp("happened_at", { withTimezone: true }).notNull(),
  kind: timelineEventKindEnum("kind").notNull().default("other"),
  note: text("note"),
  entryId: uuid("entry_id").references(() => logEntries.id),
  documentId: uuid("document_id").references(() => documents.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- timeline tracks (sub-project 6) ---
// The case as a metro map. tracks + stops REPLACE timeline_events and the
// milestone model: the main line is simply the track with no parent, and a
// side track either merges back into its parent (it was a prerequisite for
// Einde bewindvoering) or it ends.
//
// Both tables are editable display aids, deliberately NOT ledgered — exactly
// what timeline_events and the milestones table already were. A stop asserts
// nothing; it points at the evidence: log_entries, documents and tasks.

export const trackStatusEnum = pgEnum("track_status", ["open", "done", "ended"]);
export const stopStateEnum = pgEnum("stop_state", ["done", "open", "expected"]);

export const tracks = pgTable("tracks", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  status: trackStatusEnum("status").notNull().default("open"),
  // NULL = the main line. A unique index on a constant expression, filtered to
  // these rows, allows exactly one of them to exist.
  parentTrackId: uuid("parent_track_id"),
  // Where it leaves the parent. NULL is normal: migration 0026 dropped the
  // `track_branch_root_ck` check that forced a child track to name one, because
  // branch geometry is date-driven now and the pointer is semantic only — NULL
  // honestly means "nobody wrote down what this spoor came out of".
  branchesAtStopId: uuid("branches_at_stop_id"),
  // The stop on the parent it feeds into; NULL = it just ends, which is a real
  // outcome and not an unfinished one.
  mergesAtStopId: uuid("merges_at_stop_id"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const stops = pgTable("stops", {
  id: uuid("id").primaryKey().defaultRandom(),
  trackId: uuid("track_id").notNull().references(() => tracks.id),
  orderIndex: integer("order_index").notNull(),
  title: text("title").notNull(),
  kind: timelineEventKindEnum("kind").notNull().default("other"),
  state: stopStateEnum("state").notNull().default("done"),
  // NULL for a stop that has not happened yet — which is the point of an
  // expected stop, and the reason the map is laid out structurally.
  happenedAt: timestamp("happened_at", { withTimezone: true }),
  expectedAt: timestamp("expected_at", { withTimezone: true }),
  // NULL, or a WSNP stage — what makes a stop a big named station.
  stage: wsnpStageEnum("stage"),
  entryId: uuid("entry_id").references(() => logEntries.id),
  taskId: uuid("task_id").references(() => tasks.id),
  documentId: uuid("document_id").references(() => documents.id),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("stops_track_order_idx").on(t.trackId, t.orderIndex)]);

// --- searchable knowledge base (sub-project 4) ---
// DERIVED tables, deliberately NOT evidence. They hold no facts: only a
// rebuildable lookup FOR the facts that live in the evidence tables. They
// append no ledger_events and they allow UPDATE and DELETE, because the drain
// replaces chunks whose source text changed. `pnpm --filter worker reindex`
// recreates all of it from source records. A tampered index cannot corrupt the
// record — it can only fail to find it, and index health is shown on /verify.

// pg-core has no tsvector type; customType is the seam. The column IS part of
// this TypeScript schema — Postgres computes the value, drizzle knows it exists.
// drizzle-kit renders it as the quoted type name "tsvector", which resolves to
// pg_catalog.tsvector.
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() { return "tsvector"; },
});

// One row per vault document. OCR and PDF parsing are expensive, so they run
// once per sha256, ever — the content-addressed bytes are the cache key.
export const documentTexts = pgTable("document_texts", {
  documentId: uuid("document_id").primaryKey().references(() => documents.id),
  sha256: text("sha256").notNull(),
  text: text("text").notNull(),
  extractor: text("extractor").notNull(),
  // char_count is the length BEFORE the 1 MB cap; truncated says the cap bit.
  charCount: integer("char_count").notNull(),
  truncated: boolean("truncated").notNull().default(false),
  extractedAt: timestamp("extracted_at", { withTimezone: true }).notNull().defaultNow(),
});

export const searchChunks = pgTable("search_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  // title and body are denormalized on purpose: results render without joins.
  title: text("title").notNull(),
  body: text("body").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }),
  // Denormalized effective status, resolved once at index time from whichever
  // child table owns it (document_status_changes / task_status_changes /
  // registry_decisions). NULL for entities that have no status. Query-time
  // status filtering reads THIS column and never a per-type subquery. Plain
  // text, not an enum, so the vocabulary can grow without a migration. No index:
  // at most ~17 distinct values, too low-cardinality to beat the GIN/HNSW and
  // entity_type access paths — it is applied as a filter over their rows.
  status: text("status"),
  tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('dutch', title || ' ' || body)`),
  // nomic-embed-text is 768-dimensional. NULL means the embedding failed and
  // the chunk is lexical-only until a later drain retries it.
  embedding: vector("embedding", { dimensions: 768 }),
  sourceHash: text("source_hash").notNull(),
  embedAttempts: integer("embed_attempts").notNull().default(0),
  indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("search_chunk_uq").on(t.entityType, t.entityId, t.chunkIndex),
  index("search_chunks_tsv_idx").using("gin", t.tsv),
  index("search_chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  index("search_chunks_entity_type_idx").on(t.entityType),
  index("search_chunks_occurred_idx").on(t.occurredAt),
]);

// Trigger outbox: source-table triggers write (entity_type, entity_id) here and
// the search.drain job dedupes, reindexes and deletes the drained rows. Rows
// arrive ONLY through the SECURITY DEFINER trigger function, so neither
// application role is granted INSERT on this table.
export const searchOutbox = pgTable("search_outbox", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("search_outbox_enqueued_idx").on(t.enqueuedAt)]);

export const workerRuns = pgTable("worker_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  worker: text("worker").notNull(),
  status: text("status").notNull(),
  detail: jsonb("detail"),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("worker_runs_idx").on(t.worker, t.ranAt)]);

// Operational table: web-push subscriptions. Dead subscriptions are revoked
// via UPDATE (revoked = true), never deleted.
export const pushSubscriptions = pgTable("push_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  revoked: boolean("revoked").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- better-auth managed tables (schema generated by @better-auth/cli, adapted
// to project conventions: timestamptz). Distinct from our app-level `users`. ---

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
    .$onUpdate(() => new Date()),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
    .$onUpdate(() => new Date()),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
}, (t) => [index("session_user_id_idx").on(t.userId)]);

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  issuer: text("issuer").notNull(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => [index("account_user_id_idx").on(t.userId)]);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => [index("verification_identifier_idx").on(t.identifier)]);

// A registered WebAuthn credential. Managed by @better-auth/passkey, so the
// drizzle PROPERTY names must match the plugin's field names exactly — the
// drizzle adapter resolves schemaModel[field], not schemaModel[column]. The
// SQL column names stay snake_case like every other table here.
//
// Not an evidence table: no ledger event, not read by /verify. `aaguid`
// identifies the authenticator MODEL, never the device or the user, and Apple
// zeroes it under the default attestation flow — which is why the passkey is
// named by hand at registration.
export const passkey = pgTable("passkey", {
  id: text("id").primaryKey(),
  name: text("name"),
  publicKey: text("public_key").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  credentialID: text("credential_id").notNull(),
  // The plugin declares this `number`, so it must be an integer for the
  // adapter. A WebAuthn signature counter is a uint32 and could in principle
  // overflow int4; Apple and Google passkeys — the only ones in play — report
  // 0 and never increment. Revisit only if a hardware key is ever registered.
  counter: integer("counter").notNull(),
  deviceType: text("device_type").notNull(),
  backedUp: boolean("backed_up").notNull(),
  transports: text("transports"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  aaguid: text("aaguid"),
}, (t) => [
  index("passkey_user_id_idx").on(t.userId),
  index("passkey_credential_id_idx").on(t.credentialID),
]);

// --- files: bundles (sub-project 10) ---
// NOT evidence. Creating, renaming or deleting a bundle appends NO ledger
// event, the same law tracks/stops and debts follow: a bundle is a VIEW onto
// evidence, never a claim about the case. That is precisely why DELETE can be
// granted here while it stays revoked on every evidence table.
export const bundles = pgTable("bundles", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  note: text("note"),
  // 'manual' — members are rows in bundle_documents.
  // 'rule'   — members are computed from `rule` at read time.
  kind: text("kind").notNull(),
  rule: jsonb("rule"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("bundles_kind_ck", sql`${t.kind} IN ('manual','rule')`),
  check("bundles_rule_ck", sql`(${t.kind} = 'rule') = (${t.rule} IS NOT NULL)`),
]);

export const bundleDocuments = pgTable("bundle_documents", {
  bundleId: uuid("bundle_id").notNull().references(() => bundles.id),
  documentId: uuid("document_id").notNull().references(() => documents.id),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("bundle_document_uq").on(t.bundleId, t.documentId)]);
