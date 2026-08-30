import { permanentRedirect } from "next/navigation";

export default function VaultPage(): never {
  // The kluis is Files now, and the rail already points at /files — this
  // redirect exists for whoever still has bare /vault bookmarked or linked.
  // It does NOT reach `/vault/<id>`: that is a separate route (vault/[id]),
  // which now redirects on its own — its content moved to /files/[id], and
  // every in-repo link has been swept to point there directly.
  permanentRedirect("/files");
}
