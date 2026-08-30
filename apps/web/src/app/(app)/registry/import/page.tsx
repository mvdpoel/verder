import { serverCaller } from "@/lib/trpc-server";
import { StatementUpload } from "@/components/statement-upload";
import { Label, PageTitle, Panel, TextLink } from "@/components/ui";

export default async function RegistryImportPage() {
  const caller = await serverCaller();
  const imports = await caller.registry.import.list();
  return (
    <div className="flex max-w-2xl flex-col gap-7">
      <div className="flex flex-col gap-[10px]">
        <PageTitle>Afschrift inlezen</PageTitle>
        <p className="text-[13.5px] font-light leading-relaxed text-ink-mute">
          Elk bestand komt eerst in je kluis terecht — het origineel blijft altijd
          bewaard. Daarna zoeken we samen naar terugkerende afschrijvingen; er wordt
          niets toegevoegd zonder dat jij het goedkeurt.
        </p>
      </div>
      <StatementUpload />
      <Panel as="section" className="flex flex-col gap-[14px] p-[26px]">
        <Label as="h2">Eerder ingelezen</Label>
        {imports.length === 0 ? (
          <p className="text-[13px] font-light leading-relaxed text-ink-label">
            Nog geen afschriften ingelezen — de eerste is de grootste stap.
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
                  {im.total} {im.total === 1 ? "regel" : "regels"}
                  {im.errors > 0 && ` · ${im.errors} onleesbaar`}
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
          ← Terug naar het register
        </TextLink>
      </p>
    </div>
  );
}
