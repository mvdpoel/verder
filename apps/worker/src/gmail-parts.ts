/**
 * Is this message part an image the HTML body embeds, rather than something
 * the sender attached?
 *
 * Every signature logo in every footer was becoming a vault document with a
 * Title field and a "File it" button, sitting in the evidence record next to a
 * court decision — 56% of everything the watcher had filed. The walk in
 * gmail-auth.ts took any part with a filename and never read the disposition.
 *
 * A body image is `Content-Disposition: inline` AND carries a `Content-ID`
 * that the HTML references as `cid:…`. BOTH are required: an inline part
 * without a Content-ID is not a cid reference and might be a real document.
 *
 * Skipping one loses nothing — ingestRawEmail stores the full RFC822 original
 * in the vault first, so the bytes stay verifiable forever.
 *
 * Uncertainty always KEEPS the part. Over-ingesting is noise Martin can
 * discard; over-skipping is evidence he never learns arrived.
 */
export function isInlineBodyImage(
  headers: { name?: string | null; value?: string | null }[] | null | undefined,
): boolean {
  if (!headers) return false;
  const get = (want: string) =>
    headers.find((x) => x.name?.toLowerCase() === want)?.value ?? null;
  const disposition = get("content-disposition");
  const contentId = get("content-id");
  if (!disposition || !contentId) return false;
  return disposition.trim().toLowerCase().startsWith("inline");
}
