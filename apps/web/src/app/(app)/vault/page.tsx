import { permanentRedirect } from "next/navigation";

export default function VaultPage(): never {
  // The kluis is Files now, and the rail already points at /files — this
  // redirect exists for whoever still has bare /vault bookmarked or linked.
  // It does NOT reach `/vault/<id>`: that is a separate route (vault/[id]),
  // left untouched here on purpose, and the dozen in-repo links that still
  // point at it are a later, separate sweep once its content moves to
  // /files/<id>.
  permanentRedirect("/files");
}
