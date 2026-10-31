-- ONE follow-up per outbound message, enforced by the database rather than by
-- the clock's check-then-insert alone. `proposals_trigger_uq` (0038) exempts
-- follow-ups because a THREAD can be chased more than once — but each chase
-- belongs to a different outbound message, so the outbound message itself is
-- the key: Martin's own mail (trigger_raw_email_id) or a sent proposal
-- (parent_proposal_id). Without these, a second worker process or a pg-boss
-- redelivery during a slow proposals.clock tick could create two follow-ups for
-- one silence and hand the host drafter two `claude -p` runs.
--
-- A new migration rather than an edit to 0038: 0038 is applied in dev, and
-- drizzle's migrator would never re-run an edited file there.
CREATE UNIQUE INDEX "proposals_followup_raw_uq" ON "proposals" ("trigger_raw_email_id")
  WHERE "kind" = 'follow-up' AND "trigger_raw_email_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_followup_parent_uq" ON "proposals" ("parent_proposal_id")
  WHERE "kind" = 'follow-up' AND "parent_proposal_id" IS NOT NULL;
