import { bigint, index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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
