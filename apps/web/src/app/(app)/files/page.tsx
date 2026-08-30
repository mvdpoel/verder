import { serverCaller } from "@/lib/trpc-server";
import { UploadDrop } from "@/components/upload-drop";
import { FilesTree } from "@/components/files-tree";
import { FilesTable } from "@/components/files-table";
import { FilesPreview } from "@/components/files-preview";
import { BundleCards } from "@/components/bundle-cards";
import { PageTitle } from "@/components/ui";
import { parseFilesParams } from "@/lib/files-url";

/**
 * Three panes: what you narrow by, what you found, what it is.
 *
 * The kluis was three lists that answered only "wat moet ik nog sorteren".
 * Sorting is still here — it is the `status` branch — but it is now one
 * question among six rather than the only shape the page has.
 */
export default async function FilesPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parsed = parseFilesParams(await searchParams);
  const caller = await serverCaller();
  // Four independent reads, in parallel. Sequentially this is four round trips
  // before the page draws anything — the mistake the vault page fixed once.
  const [tree, bundles, browse, selected] = await Promise.all([
    caller.documents.tree(),
    caller.bundles.list(),
    // `bundels` is a VIEW, not a filter — it lists bundles themselves, so
    // there is nothing for `browse` to narrow and no reason to call it.
    parsed.branch.kind === "bundels"
      ? Promise.resolve({ rows: [], total: 0 })
      : caller.documents.browse({ branch: parsed.branch, sort: parsed.sort, dir: parsed.dir }),
    parsed.sel ? caller.documents.get({ id: parsed.sel }).catch(() => null) : null,
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageTitle>Files</PageTitle>
      <UploadDrop />
      {/* One column below lg: three panes at 300px each are three unreadable
          columns, the same reason /vault/[id] collapses its two. */}
      <div className="grid gap-5 lg:grid-cols-[210px_minmax(0,1fr)_260px]">
        <FilesTree tree={tree} bundles={bundles} parsed={parsed} />
        {parsed.branch.kind === "bundels"
          ? <BundleCards bundles={bundles} />
          : <FilesTable rows={browse.rows} total={browse.total} parsed={parsed}
              bundles={bundles.filter((b) => b.kind === "manual")
                .map((b) => ({ id: b.id, name: b.name }))} />}
        <FilesPreview doc={selected} />
      </div>
    </div>
  );
}
