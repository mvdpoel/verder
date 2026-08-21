-- Which account a statement row belongs to. Additive and nullable: existing
-- rows keep NULL and every existing reader ignores the column, so this can be
-- applied before the new images go up (and must be — the new code reads it).
--
-- transactions is an editable fact table, not evidence: adding a column here
-- appends no ledger event and cannot affect the hash chain.
ALTER TABLE "transactions" ADD COLUMN "account_iban" text;
