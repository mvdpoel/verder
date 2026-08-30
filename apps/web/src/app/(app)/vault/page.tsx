import { permanentRedirect } from "next/navigation";

export default function VaultPage(): never {
  // The kluis is Files now. Bookmarks and anything that still links here keep
  // working; every in-repo link was updated in the same change.
  permanentRedirect("/files");
}
