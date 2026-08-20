/** A Gmail message part, narrowed to what the skip decision reads. */
export interface SkippablePart {
  mimeType?: string | null;
  headers?: { name?: string | null; value?: string | null }[] | null;
}

/**
 * Is this message part an image the HTML body embeds, rather than something
 * the sender attached?
 *
 * Every signature logo in every footer was becoming a vault document with a
 * Title field and a "File it" button, sitting in the evidence record next to a
 * court decision — 56% of everything the watcher had filed. The walk in
 * gmail-auth.ts took any part with a filename and never read the disposition.
 *
 * A body image is an `image/*` part that is `Content-Disposition: inline` AND
 * carries a `Content-ID` the HTML references as `cid:…`. ALL THREE are
 * required:
 *
 * - The mime check is not decoration. macOS and iOS Mail mark EVERY attachment
 *   `Content-Disposition: inline` and give it a `Content-Id` — that is why
 *   Mail.app attachments render embedded in other clients — and scan-to-email
 *   MFPs do the same. Without it, a bewindvoerder mailing a Beschikking.pdf
 *   from a Mac loses the court decision, and the loss is unrecoverable in
 *   practice: pollGmail short-circuits on a seen gmailMessageId, so re-polling
 *   after a fix never fetches the message again.
 * - An inline part with no Content-ID is not a cid reference and might be a
 *   real document.
 *
 * Skipping one loses nothing — ingestRawEmail stores the full RFC822 original
 * in the vault first, so the bytes stay verifiable forever. But nothing in this
 * repo can parse them back out, so a wrong skip is a document Martin never
 * learns arrived. That asymmetry decides every ambiguous case here:
 *
 * Uncertainty always KEEPS the part. Absent headers keep it. A part whose
 * Content-Disposition occurs twice and disagrees keeps it — skipping needs
 * EVERY occurrence to say inline, because resolving a contradiction toward an
 * irreversible action is the wrong direction. Over-ingesting is noise Martin
 * can discard in one click.
 *
 * Every skip is recorded by the caller (see collectAttachments): a decision
 * this consequential must not be invisible.
 */
export function isInlineBodyImage(part: SkippablePart | null | undefined): boolean {
  const headers = part?.headers;
  if (!part || !Array.isArray(headers)) return false;
  const all = (want: string) => headers
    .filter((x) => x.name?.toLowerCase() === want)
    .map((x) => x.value)
    .filter((v): v is string => typeof v === "string");

  const dispositions = all("content-disposition");
  if (dispositions.length === 0) return false;
  // EVERY occurrence must say inline — a contradiction keeps the part.
  if (!dispositions.every((d) => d.trim().toLowerCase().startsWith("inline"))) return false;

  if (all("content-id").length === 0) return false;

  // The part's declared mime, falling back to its Content-Type header. Neither
  // present means we do not know what this is, which means we keep it.
  const mime = part.mimeType ?? all("content-type")[0] ?? "";
  return mime.trim().toLowerCase().startsWith("image/");
}
