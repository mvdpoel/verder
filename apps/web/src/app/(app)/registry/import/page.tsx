import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";
import { StatementUpload } from "@/components/statement-upload";

export default async function RegistryImportPage() {
  const caller = await serverCaller();
  const imports = await caller.registry.import.list();
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Import a statement</h1>
        <p className="text-slate-600 mt-1">
          Every file lands in your vault first — the original is always kept.
          Then we look for recurring charges together; nothing is added without your say-so.
        </p>
      </div>
      <StatementUpload />
      <div>
        <h2 className="text-lg font-semibold mb-2">Past imports</h2>
        {imports.length === 0 ? (
          <p className="text-sm text-slate-600">
            No statements imported yet — your first one is the biggest step.
          </p>
        ) : (
          <ul className="space-y-2">
            {imports.map((im) => (
              <li key={im.statementSha256} className="rounded border bg-white p-3 text-sm flex justify-between gap-2">
                <span>
                  <span className="font-medium">{im.documentTitle ?? im.statementSha256.slice(0, 12)}</span>
                  <span className="text-slate-500"> · {im.source}</span>
                </span>
                <span className="text-slate-500 shrink-0">
                  {im.total} row{im.total === 1 ? "" : "s"}
                  {im.errors > 0 && ` · ${im.errors} unreadable`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-sm">
        <Link href="/registry" className="underline">← Back to the registry</Link>
      </p>
    </div>
  );
}
