import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const channelEnum = pgEnum("channel", ["call", "meeting", "email", "whatsapp", "voicemail", "letter", "other"]);
export const directionEnum = pgEnum("direction", ["inbound", "outbound", "internal"]);
export const entrySourceEnum = pgEnum("entry_source", ["manual", "gmail-watch", "nas-watch"]);
export const docSourceEnum = pgEnum("doc_source", ["upload", "nas-scan", "email-attachment"]);
export const docStatusEnum = pgEnum("doc_status", ["inbox", "filed"]);
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
export const txSourceEnum = pgEnum("tx_source", ["abn-camt053", "abn-tsv", "paypal-csv"]);

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
  // Transactional-outbox marker: set once the suggest.entry job for this email
  // has been enqueued. NULL means the ingest committed but the enqueue is still
  // owed — the gmail poller retries it on the next cycle.
  suggestQueuedAt: timestamp("suggest_queued_at", { withTimezone: true }),
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
  claimedCents: integer("claimed_cents").notNull(),
  references_: text("references"),
  origin: text("origin"),
  originStory: text("origin_story"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const transactions = pgTable("transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: txSourceEnum("source").notNull(),
  bookedAt: timestamp("booked_at", { withTimezone: true }).notNull(),
  amountCents: integer("amount_cents").notNull(), // signed: debits negative
  counterpartyName: text("counterparty_name"),
  counterpartyIban: text("counterparty_iban"),
  description: text("description"),
  mandateId: text("mandate_id"),
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

// --- tasks + milestones (sub-project 3) ---
// tasks and milestones are editable fact tables (UPDATE allowed, DELETE never).
// task_status_changes is an EVIDENCE table: insert-only, ledger-backed
// (eventType "task.status", entityType "task_status_change").

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

export const milestones = pgTable("milestones", {
  id: uuid("id").primaryKey().defaultRandom(),
  stage: wsnpStageEnum("stage").notNull(),
  title: text("title").notNull(),
  happenedAt: timestamp("happened_at", { withTimezone: true }),
  expectedAt: timestamp("expected_at", { withTimezone: true }),
  done: boolean("done").notNull().default(false),
  note: text("note"),
  entryId: uuid("entry_id").references(() => logEntries.id),
  documentId: uuid("document_id").references(() => documents.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Curated key events: Martin's hand-picked story of the process (intake,
// request sent to court, a call, a letter that arrived). Editable display aid
// like milestones — NOT ledgered; linked logbook entries and documents remain
// the evidence.
export const timelineEventKindEnum = pgEnum("timeline_event_kind", ["process", "mail", "call", "meeting", "document", "other"]);

export const timelineEvents = pgTable("timeline_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  happenedAt: timestamp("happened_at", { withTimezone: true }).notNull(),
  kind: timelineEventKindEnum("kind").notNull().default("other"),
  note: text("note"),
  entryId: uuid("entry_id").references(() => logEntries.id),
  documentId: uuid("document_id").references(() => documents.id),
  milestoneId: uuid("milestone_id").references(() => milestones.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
