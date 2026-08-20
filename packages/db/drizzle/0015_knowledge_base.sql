CREATE TABLE "document_texts" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"sha256" text NOT NULL,
	"text" text NOT NULL,
	"extractor" text NOT NULL,
	"char_count" integer NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"occurred_at" timestamp with time zone,
	"status" text,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('dutch', title || ' ' || body)) STORED,
	"embedding" vector(768),
	"source_hash" text NOT NULL,
	"embed_attempts" integer DEFAULT 0 NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_texts" ADD CONSTRAINT "document_texts_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "search_chunk_uq" ON "search_chunks" USING btree ("entity_type","entity_id","chunk_index");--> statement-breakpoint
CREATE INDEX "search_chunks_tsv_idx" ON "search_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "search_chunks_embedding_idx" ON "search_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "search_chunks_entity_type_idx" ON "search_chunks" USING btree ("entity_type");--> statement-breakpoint
CREATE INDEX "search_chunks_occurred_idx" ON "search_chunks" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "search_outbox_enqueued_idx" ON "search_outbox" USING btree ("enqueued_at");