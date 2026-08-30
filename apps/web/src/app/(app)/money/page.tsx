import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";
import { MoneyChart } from "@/components/money-chart";
import { CADENCE_LABEL, CATEGORY_LABEL, euro } from "@/components/money-format";
import { incomeLineSummaries } from "@/lib/money-disclosures";
import { buttonClass, Chip, Empty, Label, Micro, PageTitle, Panel } from "@/components/ui";

/**
 * Geld in en uit. Everything on this page is derived on read from evidence that
 * is already in the ledger — bank rows for the past, the registry's contracts
 * for the near future. Nothing here writes, asserts or files anything.
 *
 * The page reports; it never judges. A month that got worse is a fact too, and
 * the "na opzeggen" line is here because something can be done — not because
 * something went wrong.
 *
 * NO AMBER ANYWHERE ON THIS PAGE, deliberately. Amber means "waiting on
 * Martin", and nothing here is: a hatched month is a statement that has not
 * been imported yet, an incidental credit is a disclosure, and money going out
 * is simply what happened. The coverage warnings are told apart by PATTERN —
 * filled, hatched, dashed, or an explicit gap — which is the distinction the
 * whole page rests on and the one thing colour must not be asked to carry.
 */

const SHA256 = /^[0-9a-f]{64}$/;

export default async function MoneyPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string; month?: string; account?: string }>;
}) {
  const { cat, month, account } = await searchParams;
  const caller = await serverCaller();
  const { series, accountLabels } = await caller.money.series();

  if (series.length === 0) {
    return (
      <div className="space-y-6">
        <PageTitle>
          Geld in en uit
        </PageTitle>
        <Empty
          title={
            <span className="block max-w-md text-center">
              Nog geen afschriften ingelezen — zodra je een bankafschrift importeert
              bouwt dit overzicht zichzelf op.
            </span>
          }
          action={
            <Link className={buttonClass("primary")} href="/registry/import">
              Afschrift importeren
            </Link>
          }
        />
      </div>
    );
  }

  const detail = month
    ? await caller.money.month({ accountIban: account ?? null, month })
    : null;

  // Every bank row behind the drill panel links back to the statement it came
  // from. The link is evidence, not ownership: a discarded statement document
  // does not remove its transactions, so a missing document is not an error.
  const statementDocs = new Map<string, { id: string; title: string }>();
  if (detail) {
    const shas = [
      ...new Set(
        detail.categories.flatMap((c) => c.transactions.map((t) => t.statementSha256))
      ),
    ].filter((sha) => SHA256.test(sha));
    for (const sha of shas) {
      try {
        const doc = await caller.documents.bySha({ sha256: sha });
        statementDocs.set(sha, { id: doc.id, title: doc.effectiveTitle ?? doc.title });
      } catch {
        // No document for this statement (imported before the vault, or the
        // sha is a fixture). The rows stay; only the link is missing.
      }
    }
  }

  const accountName = (iban: string | null) =>
    iban ? (accountLabels[iban] ?? iban) : "onbekende rekening";

  return (
    <div className="space-y-8">
      <div>
        <PageTitle>
          Geld in en uit
        </PageTitle>
        <p className="mt-3 max-w-3xl text-[13.5px] font-light leading-relaxed text-ink-mute">
          Wat er binnenkomt, wat eruit gaat en wat er overblijft — per maand en per
          rekening, opgebouwd uit de afschriften en de vaste lasten die al in het
          dossier staan.
        </p>
      </div>

      {/* Header: the last month the statements provably cover in full. Not the
          month of the newest transaction — that one is nearly always half
          imported and would report a shortfall that is only missing data. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {series.map((s) => {
          const last = s.lastCompleteMonth
            ? s.months.find((m) => m.month === s.lastCompleteMonth)
            : undefined;
          return (
            <Panel key={s.accountIban ?? "unknown"} className="p-[22px]">
              <Label className="truncate">{accountName(s.accountIban)}</Label>
              {last ? (
                <>
                  <Micro className="mt-[7px]">laatste volledige maand · {last.month}</Micro>
                  <dl
                    className="mt-4 space-y-[9px] text-[13px] font-light"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="text-ink-mute">vast inkomen</dt>
                      <dd className="font-mono text-ink-soft">{euro(last.inCents)}</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="text-ink-mute">uitgaven</dt>
                      <dd className="font-mono text-ink-soft">{euro(last.outCents)}</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-3 border-t border-hairline pt-[9px]">
                      <dt className="text-ink-mute">blijft over</dt>
                      <dd className="font-mono text-[15px] text-ink-bright">
                        {euro(last.inCents - last.outCents)}
                      </dd>
                    </div>
                  </dl>
                  {/* The sum above is asymmetric on purpose and must say so
                      HERE. "vast inkomen" counts recurring credits only, while
                      "uitgaven" counts every debit — so in a month with an
                      incidental credit it subtracts all the spending from part
                      of the income, and "blijft over" reads worse than the bank
                      does. The recurring-only rule is measured and stays; what
                      cannot stay is the reader meeting the shortfall two
                      screens before the footnote that explains it. */}
                  {last.incidentalCents > 0 && (
                    <p className="mt-4 text-[12px] font-light leading-relaxed text-ink-label">
                      Er kwam die maand ook {euro(last.incidentalCents)} incidenteel
                      binnen. Dat telt hier niet mee — in dit bedrag staat alleen
                      terugkerend inkomen. De losse regels staan onderaan, bij “wat
                      er niet in de balken zit”.
                    </p>
                  )}
                </>
              ) : (
                <p className="mt-3 text-[13px] font-light leading-relaxed text-ink-mute">
                  Nog geen maand die volledig door een afschrift gedekt wordt — zodra
                  er één compleet is staat hij hier.
                </p>
              )}
            </Panel>
          );
        })}
      </div>

      {/* Two cards next to each other invite one addition, and that addition is
          wrong. Under bewind the leefgeld is income on the leefgeldrekening and
          an "overig" cost on the beheerrekening — the same money, seen from both
          ends — so a total across the cards counts it twice. The accounts are
          kept apart on purpose (merging them would draw a collapse at the
          handover that never happened); the reader has to be told that, next to
          the cards, or the page has simply moved the mistake to them. */}
      {series.length > 1 && (
        <p className="max-w-3xl text-[13px] font-light leading-relaxed text-ink-mute">
          Deze rekeningen staan los van elkaar en horen niet bij elkaar opgeteld te
          worden. Leefgeld telt op de leefgeldrekening als inkomen en op de
          beheerrekening als uitgave — hetzelfde geld, van twee kanten gezien. Lees
          de kaarten dus naast elkaar, niet als één totaal.
        </p>
      )}

      <MoneyChart
        series={series}
        accountLabels={accountLabels}
        focusCategory={cat}
        selected={month ? { account: account ?? null, month } : null}
      />

      {/* Where the income bars come from. `incomeLines` folds a successor
          counterparty into its predecessor — the single feature that keeps
          Martin's chart from reporting his income as ended in June 2026 — and
          it was rendered nowhere at all. A bar the reader cannot trace back to a
          name is a number he has to take on faith, and this page does not ask
          for faith. */}
      <Panel as="section" className="p-[26px]">
        {/* Still an <h2>: the section headings on this page read as the
            system's small caps, but the document outline is what a screen
            reader navigates by and it stays intact. */}
        <Label as="h2">Waar het vaste inkomen vandaan komt</Label>
        <p className="mt-3 max-w-3xl text-[13px] font-light leading-relaxed text-ink-mute">
          Hierop zijn de inkomstenbalken en de prognose gebouwd: bijschrijvingen van
          een tegenpartij die op een vast ritme betaalt. Het bedrag is wat één
          volledige periode oplevert, zodat een deelmaand aan het begin of eind van
          een baan de prognose niet omlaag trekt. Een pijl betekent dat hetzelfde
          inkomen onder een nieuwe naam doorloopt — bijvoorbeeld na een
          baanwissel — en dat het als één lijn geteld wordt.
        </p>
        <div className="mt-5 space-y-5">
          {series.map((s) => {
            const lines = incomeLineSummaries(s.incomeLines);
            return (
              <div key={s.accountIban ?? "unknown"}>
                <Label className="truncate">{accountName(s.accountIban)}</Label>
                {lines.length === 0 ? (
                  <p className="mt-2 text-[13px] font-light leading-relaxed text-ink-mute">
                    Nog geen terugkerende bijschrijving herkend op deze rekening —
                    zodra er twee betalingen in hetzelfde ritme binnen zijn staat de
                    lijn hier.
                  </p>
                ) : (
                  <ul className="mt-2">
                    {lines.map((l) => (
                      <li
                        key={l.key}
                        className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-hairline py-[11px] last:border-0">
                        <span className="text-[13.5px] text-ink-soft">{l.label}</span>
                        {l.continued && <Chip tone="signal">voortgezet</Chip>}
                        <span
                          className="ml-auto font-mono text-[11px] tracking-[0.1em] text-ink-dim"
                          style={{ fontVariantNumeric: "tabular-nums" }}
                        >
                          {CADENCE_LABEL[l.cadence] ?? l.cadence}{" "}
                          <span className="text-[13px] text-ink-soft">
                            {euro(l.typicalAmountCents)}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </Panel>

      {detail && (
        <Panel as="section" className="p-[26px]">
          <div className="flex flex-wrap items-baseline gap-3">
            <h2 className="font-mono text-[12px] tracking-[0.16em] uppercase text-ink-bright">
              {detail.month} · {accountName(detail.accountIban)}
            </h2>
            <Link
              href={cat ? `/money?cat=${encodeURIComponent(cat)}` : "/money"}
              className="ml-auto font-mono text-[10px] tracking-[0.16em] uppercase text-ink-dim transition-colors hover:text-signal">
              sluiten
            </Link>
          </div>
          {detail.categories.length === 0 ? (
            <p className="mt-3 text-[13px] font-light text-ink-mute">
              Geen uitgaven in deze maand op deze rekening.
            </p>
          ) : (
            <div className="mt-5 space-y-2">
              {detail.categories.map((c) => (
                <details
                  key={c.category}
                  open={cat === c.category}
                  className="rounded-panel border border-edge">
                  <summary className="flex cursor-pointer items-baseline justify-between gap-3 px-[14px] py-[11px] text-[13.5px] font-light text-ink-soft">
                    <span>{CATEGORY_LABEL[c.category] ?? c.category}</span>
                    <span
                      className="font-mono text-[13px] text-ink"
                      style={{ fontVariantNumeric: "tabular-nums" }}
                    >
                      {euro(c.cents)}
                    </span>
                  </summary>
                  <ul className="border-t border-hairline">
                    {c.transactions.map((t) => {
                      const doc = statementDocs.get(t.statementSha256);
                      return (
                        <li
                          key={t.id}
                          className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-hairline px-[14px] py-[10px] text-[13px] font-light last:border-0">
                          <span className="w-20 shrink-0 font-mono text-[10px] tracking-[0.1em] text-ink-dim">
                            {new Date(t.bookedAt).toLocaleDateString("nl-NL")}
                          </span>
                          <span className="text-ink-soft">
                            {t.itemName ?? t.counterpartyName ?? "onbekende tegenpartij"}
                          </span>
                          {t.itemName && t.counterpartyName && (
                            <span className="text-[12px] text-ink-label">{t.counterpartyName}</span>
                          )}
                          <span
                            className="ml-auto font-mono text-ink"
                            style={{ fontVariantNumeric: "tabular-nums" }}
                          >
                            {euro(t.amountCents)}
                          </span>
                          {doc ? (
                            <Link
                              className="w-full font-mono text-[10px] tracking-[0.1em] text-ink-dim transition-colors hover:text-signal"
                              href={`/files/${doc.id}`}>
                              → afschrift: {doc.title}
                            </Link>
                          ) : (
                            <span className="w-full font-mono text-[10px] tracking-[0.1em] text-ink-faint">
                              afschrift niet in de kluis gevonden
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </details>
              ))}
            </div>
          )}
          {detail.parseErrorRows > 0 && (
            <p className="mt-4 text-[12px] font-light text-ink-label">
              {detail.parseErrorRows} regel(s) in deze maand waren onleesbaar en tellen
              nergens in mee.
            </p>
          )}
        </Panel>
      )}

      {/* Disclosures. Everything the bars leave out is on the same screen —
          that is what makes the arithmetic reconcile. Removing this block makes
          the page lie, and the number VerderGroep reads must never be silently
          understated. */}
      <Panel as="section" className="p-[26px]">
        <Label as="h2">Wat er niet in de balken zit</Label>
        {series.every((s) =>
          s.months.every(
            (m) =>
              m.incidentalCents === 0 &&
              m.internalCents === 0 &&
              m.parseErrorRows === 0 &&
              m.coverage === "complete"
          )
        ) ? (
          <p className="mt-3 max-w-3xl text-[13px] font-light leading-relaxed text-ink-mute">
            Niets. Elke maand hierboven is volledig gedekt door een afschrift, en
            elke bijschrijving telt mee als vast inkomen.
          </p>
        ) : (
          <div className="mt-5 space-y-6">
            {series.map((s) => {
              const notes = s.months.filter(
                (m) =>
                  m.incidentalCents > 0 ||
                  m.internalCents > 0 ||
                  m.parseErrorRows > 0 ||
                  m.coverage !== "complete"
              );
              if (notes.length === 0) return null;
              return (
                <div key={s.accountIban ?? "unknown"}>
                  <Label className="truncate">{accountName(s.accountIban)}</Label>
                  <ul className="mt-2 space-y-3 text-[13px] font-light text-ink-mute">
                    {notes.map((m) => (
                      <li key={m.month} className="space-y-1 border-b border-hairline pb-3 last:border-0">
                        <div className="flex flex-wrap items-baseline gap-x-3">
                          <span className="font-mono text-[11px] tracking-[0.12em] text-ink-soft">
                            {m.month}
                          </span>
                          {m.coverage === "none" && <span>geen data — geen afschrift voor deze maand</span>}
                          {m.coverage === "partial" && (
                            <span>mogelijk incompleet — het afschrift dekt niet de hele maand</span>
                          )}
                          {m.parseErrorRows > 0 && (
                            <span>{m.parseErrorRows} onleesbare regel(s), nergens meegeteld</span>
                          )}
                        </div>
                        {/* The totals stay, and the rows go under them. A cent
                            figure on its own cannot be checked: it does not say
                            WHICH credit was left out, so a belastingteruggave
                            and a credit the rules got wrong look identical.
                            Never truncated — a list that stops at five hides
                            exactly the row someone went looking for. */}
                        {m.incidentalCents > 0 && (
                          <div>
                            <span>
                              {euro(m.incidentalCents)} incidenteel niet meegeteld
                              (vakantiegeld, teruggave, eenmalige betalingen)
                            </span>
                            <DisclosedRows rows={m.incidentalRows} />
                          </div>
                        )}
                        {m.internalCents > 0 && (
                          <div>
                            <span>
                              {euro(m.internalCents)} eigen overboeking, geen inkomen
                            </span>
                            <DisclosedRows rows={m.internalRows} />
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
        <p className="mt-5 max-w-3xl text-[12px] font-light leading-relaxed text-ink-label">
          Alleen terugkerende bijschrijvingen tellen als vast inkomen. Rekeningen
          worden nooit samengevoegd: geld dat van de ene eigen rekening naar de
          andere gaat is een overboeking, geen inkomen.
        </p>
      </Panel>
    </div>
  );
}

/**
 * The credits behind one disclosure total: date, tegenpartij, bedrag. The
 * engine sums `incidentalCents` and `internalCents` FROM these same lists, so
 * the figure above them and the rows beneath cannot drift apart.
 *
 * No rule lives here — the shape and the order (oldest first, id breaking the
 * tie) are decided in `money-series.ts` — so there is nothing here to unit-test
 * beyond the JSX itself.
 */
function DisclosedRows({
  rows,
}: {
  rows: readonly {
    id: string; bookedAt: Date; amountCents: number; counterpartyName: string | null;
  }[];
}) {
  return (
    <ul className="mt-2 space-y-[3px] border-l border-hairline pl-[13px] text-[12px] text-ink-dim">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-baseline gap-x-3">
          <span className="w-20 shrink-0 font-mono text-[10px] tracking-[0.1em]">
            {new Date(r.bookedAt).toLocaleDateString("nl-NL")}
          </span>
          <span className="font-light text-ink-mute">
            {r.counterpartyName ?? "onbekende tegenpartij"}
          </span>
          <span
            className="ml-auto font-mono text-[11px]"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {euro(r.amountCents)}
          </span>
        </li>
      ))}
    </ul>
  );
}
