-- Documents captured with the verder iPhone app get their own sources: a
-- letter photographed with the camera (phone-scan) and a file handed to the
-- app through the share sheet (phone-share). Additive only: ADD VALUE never
-- rewrites or invalidates an existing row, so the append-only evidence
-- guarantee is untouched.
ALTER TYPE "public"."doc_source" ADD VALUE 'phone-scan';--> statement-breakpoint
ALTER TYPE "public"."doc_source" ADD VALUE 'phone-share';
