import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";
import { MoneyChart } from "@/components/money-chart";
import { CADENCE_LABEL, CATEGORY_LABEL, euro } from "@/components/money-format";
import { incomeLineSummaries } from "@/lib/money-disclosures";

/**
 * Geld in en uit. Everything on this page is derived on read from evidence that
 * is already in the ledger — bank rows for the past, the registry's contracts
 * for the near future. Nothing here writes, asserts or files anything.
 *
 * The page reports; it never judges. A month that got worse is a fact too, and
 * the "na opzeggen" line is here because something can be done — not because
 * something went wrong.
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
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Geld in en uit</h1>
        <p className="text-slate-600">
          Nog geen afschriften ingelezen — zodra je een bankafschrift importeert
          bouwt dit overzicht zichzelf op.
        </p>
        <Link className="text-blue-600 underline" href="/registry/import">
          Afschrift importeren
        </Link>
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
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Geld in en uit</h1>
        <p className="mt-1 text-slate-600">
          Wat er binnenkomt, wat eruit gaat en wat er overblijft — per maand en per
          rekening, opgebouwd uit de afschriften en de vaste lasten die al in het
          dossier staan.
        </p>
      </div>

      {/* Header: the last month the statements provably cover in full. Not the
          month of the newest transaction — that one is nearly always half
          imported and would report a shortfall that is only missing data. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {series.map((s) => {
          const last = s.lastCompleteMonth
            ? s.months.find((m) => m.month === s.lastCompleteMonth)
            : undefined;
          return (
            <div key={s.accountIban ?? "unknown"} className="rounded border bg-white p-4">
              <p className="truncate text-xs font-medium text-slate-500" title={accountName(s.accountIban)}>
                {accountName(s.accountIban)}
              </p>
              {last ? (
                <>
                  <p className="mt-1 text-xs text-slate-500">
                    laatste volledige maand · {last.month}
                  </p>
                  <dl className="mt-2 space-y-1 text-sm" style={{ fontVariantNumeric: "tabular-nums" }}>
                    <div className="flex justify-between">
                      <dt className="text-slate-600">vast inkomen</dt>
                      <dd className="font-medium">{euro(last.inCents)}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-slate-600">uitgaven</dt>
                      <dd className="font-medium">{euro(last.outCents)}</dd>
                    </div>
                    <div className="flex justify-between border-t pt-1">
                      <dt className="text-slate-600">blijft over</dt>
                      <dd className="font-semibold">{euro(last.inCents - last.outCents)}</dd>
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
                    <p className="mt-2 text-xs text-slate-600">
                      Er kwam die maand ook {euro(last.incidentalCents)} incidenteel
                      binnen. Dat telt hier niet mee — in dit bedrag staat alleen
                      terugkerend inkomen. De losse regels staan onderaan, bij “wat
                      er niet in de balken zit”.
                    </p>
                  )}
                </>
              ) : (
                <p className="mt-2 text-sm text-slate-500">
                  Nog geen maand die volledig door een afschrift gedekt wordt — zodra
                  er één compleet is staat hij hier.
                </p>
              )}
            </div>
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
        <p className="text-sm text-slate-600">
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
      <section className="rounded border bg-white p-4">
        <h2 className="font-semibold">Waar het vaste inkomen vandaan komt</h2>
        <p className="mt-1 text-sm text-slate-600">
          Hierop zijn de inkomstenbalken en de prognose gebouwd: bijschrijvingen van
          een tegenpartij die op een vast ritme betaalt. Het bedrag is wat één
          volledige periode oplevert, zodat een deelmaand aan het begin of eind van
          een baan de prognose niet omlaag trekt. Een pijl betekent dat hetzelfde
          inkomen onder een nieuwe naam doorloopt — bijvoorbeeld na een
          baanwissel — en dat het als één lijn geteld wordt.
        </p>
        <div className="mt-3 space-y-3">
          {series.map((s) => {
            const lines = incomeLineSummaries(s.incomeLines);
            return (
              <div key={s.accountIban ?? "unknown"}>
                <p className="truncate text-xs font-medium text-slate-500" title={accountName(s.accountIban)}>
                  {accountName(s.accountIban)}
                </p>
                {lines.length === 0 ? (
                  <p className="mt-1 text-sm text-slate-600">
                    Nog geen terugkerende bijschrijving herkend op deze rekening —
                    zodra er twee betalingen in hetzelfde ritme binnen zijn staat de
                    lijn hier.
                  </p>
                ) : (
                  <ul className="mt-1 space-y-1 text-sm">
                    {lines.map((l) => (
                      <li key={l.key} className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-medium text-slate-700">{l.label}</span>
                        {l.continued && (
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                            voortgezet
                          </span>
                        )}
                        <span
                          className="ml-auto text-slate-600"
                          style={{ fontVariantNumeric: "tabular-nums" }}
                        >
                          {CADENCE_LABEL[l.cadence] ?? l.cadence}{" "}
                          <span className="font-medium text-slate-800">
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
      </section>

      {detail && (
        <section className="rounded border bg-white p-4">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="font-semibold">
              {detail.month} · {accountName(detail.accountIban)}
            </h2>
            <Link
              href={cat ? `/money?cat=${encodeURIComponent(cat)}` : "/money"}
              className="ml-auto text-sm text-slate-500 hover:underline"
            >
              sluiten
            </Link>
          </div>
          {detail.categories.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">
              Geen uitgaven in deze maand op deze rekening.
            </p>
          ) : (
            <div className="mt-3 space-y-3">
              {detail.categories.map((c) => (
                <details key={c.category} open={cat === c.category} className="rounded border">
                  <summary className="flex cursor-pointer justify-between px-3 py-2 text-sm">
                    <span className="font-medium">
                      {CATEGORY_LABEL[c.category] ?? c.category}
                    </span>
                    <span style={{ fontVariantNumeric: "tabular-nums" }}>{euro(c.cents)}</span>
                  </summary>
                  <ul className="divide-y border-t text-sm">
                    {c.transactions.map((t) => {
                      const doc = statementDocs.get(t.statementSha256);
                      return (
                        <li key={t.id} className="flex flex-wrap items-baseline gap-2 px-3 py-2">
                          <span className="w-20 text-xs text-slate-500">
                            {new Date(t.bookedAt).toLocaleDateString("nl-NL")}
                          </span>
                          <span className="text-slate-700">
                            {t.itemName ?? t.counterpartyName ?? "onbekende tegenpartij"}
                          </span>
                          {t.itemName && t.counterpartyName && (
                            <span className="text-xs text-slate-400">{t.counterpartyName}</span>
                          )}
                          <span
                            className="ml-auto font-medium"
                            style={{ fontVariantNumeric: "tabular-nums" }}
                          >
                            {euro(t.amountCents)}
                          </span>
                          {doc ? (
                            <Link
                              className="w-full text-xs text-slate-500 hover:underline"
                              href={`/vault/${doc.id}`}
                            >
                              → afschrift: {doc.title}
                            </Link>
                          ) : (
                            <span className="w-full text-xs text-slate-400">
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
            <p className="mt-3 text-xs text-slate-500">
              {detail.parseErrorRows} regel(s) in deze maand waren onleesbaar en tellen
              nergens in mee.
            </p>
          )}
        </section>
      )}

      {/* Disclosures. Everything the bars leave out is on the same screen —
          that is what makes the arithmetic reconcile. Removing this block makes
          the page lie, and the number VerderGroep reads must never be silently
          understated. */}
      <section className="rounded border bg-white p-4">
        <h2 className="font-semibold">Wat er niet in de balken zit</h2>
        {series.every((s) =>
          s.months.every(
            (m) =>
              m.incidentalCents === 0 &&
              m.internalCents === 0 &&
              m.parseErrorRows === 0 &&
              m.coverage === "complete"
          )
        ) ? (
          <p className="mt-2 text-sm text-slate-600">
            Niets. Elke maand hierboven is volledig gedekt door een afschrift, en
            elke bijschrijving telt mee als vast inkomen.
          </p>
        ) : (
          <div className="mt-3 space-y-4">
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
                  <p className="truncate text-xs font-medium text-slate-500">
                    {accountName(s.accountIban)}
                  </p>
                  <ul className="mt-1 space-y-1 text-sm text-slate-600">
                    {notes.map((m) => (
                      <li key={m.month} className="space-y-1">
                        <div className="flex flex-wrap gap-x-2">
                          <span className="font-medium text-slate-700">{m.month}</span>
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
        <p className="mt-3 text-xs text-slate-500">
          Alleen terugkerende bijschrijvingen tellen als vast inkomen. Rekeningen
          worden nooit samengevoegd: geld dat van de ene eigen rekening naar de
          andere gaat is een overboeking, geen inkomen.
        </p>
      </section>
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
    <ul className="mt-1 space-y-0.5 border-l pl-3 text-xs text-slate-500">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-baseline gap-x-2">
          <span className="w-20">{new Date(r.bookedAt).toLocaleDateString("nl-NL")}</span>
          <span className="text-slate-600">
            {r.counterpartyName ?? "onbekende tegenpartij"}
          </span>
          <span className="ml-auto" style={{ fontVariantNumeric: "tabular-nums" }}>
            {euro(r.amountCents)}
          </span>
        </li>
      ))}
    </ul>
  );
}
