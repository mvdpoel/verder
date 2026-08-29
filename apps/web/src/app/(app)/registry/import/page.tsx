import { serverCaller } from "@/lib/trpc-server";
import { StatementUpload } from "@/components/statement-upload";
import { Label, PageTitle, Panel, TextLink } from "@/components/ui";

export default async function RegistryImportPage() {
  const caller = await serverCaller();
  const imports = await caller.registry.import.list();
  return (
    <div className="flex max-w-2xl flex-col gap-7">
      <div className="flex flex-col gap-[10px]">
        <PageTitle>Import a statement</PageTitle>
        <p className="text-[13.5px] font-light leading-relaxed text-ink-mute">
          Every file lands in your vault first — the original is always kept.
          Then we look for recurring charges together; nothing is added without your say-so.
        </p>
      </div>
      <StatementUpload />
      <Panel as="section" className="flex flex-col gap-[14px] p-[26px]">
        <Label as="h2">Past imports</Label>
        {imports.length === 0 ? (
          <p className="text-[13px] font-light leading-relaxed text-ink-label">
            No statements imported yet — your first one is the biggest step.
          </p>
        ) : (
          <ul>
            {imports.map((im) => (
              <li
                key={im.statementSha256}
                className="flex justify-between gap-4 border-b border-hairline py-[12px] last:border-0">
                <span className="min-w-0 truncate text-[13.5px] font-light text-ink-soft">
                  <span className="text-ink-bright">{im.documentTitle ?? im.statementSha256.slice(0, 12)}</span>
                  <span className="micro"> · {im.source}</span>
                </span>
                <span className="shrink-0 font-mono text-[10px] tracking-[0.14em] uppercase text-ink-dim">
                  {im.total} row{im.total === 1 ? "" : "s"}
                  {im.errors > 0 && ` · ${im.errors} unreadable`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <p>
        <TextLink
          href="/registry"
          className="font-mono text-[10.5px] tracking-[0.16em] uppercase">
          ← Back to the registry
        </TextLink>
      </p>
    </div>
  );
}
