import { permanentRedirect } from "next/navigation";

export default async function VaultDocument({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // The detail page moved to /files/[id]; this exists for whoever still has
  // a /vault/<id> link or bookmark. The bare /vault redirect (vault/page.tsx)
  // is a separate route and does not cover this one.
  permanentRedirect(`/files/${id}`);
}
