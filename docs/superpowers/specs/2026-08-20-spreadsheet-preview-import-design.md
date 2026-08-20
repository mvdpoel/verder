# Spreadsheet Preview + ABN Excel Import — Design Spec

**Date:** 2026-08-20
**Status:** Approved design, pending implementation plan
**Scope:** Cross-cutting fix spanning the vault (sub-project 1), the financial
registry (sub-project 2), and the knowledge base (sub-project 4)

## Purpose

Two failures share one root cause, and this spec fixes both.

Opening `abn.amro.afschriften.vanaf.april.2026.xlsx` in the vault downloads the
file instead of showing it. Uploading the same file to the financial registry
fails with *"Unrecognized statement format"* — even though it came straight from
ABN AMRO. The document is also invisible to search and to `registry.mine`,
sitting at `extractor: none, char_count: 0`.

Every one of those is the same gap: nothing in the system can open a spreadsheet.

## The finding that shapes the design

The file is **not an `.xlsx`**. Its first bytes are `d0 cf 11 e0 a1 b1 1a e1` —
an OLE2 compound file, i.e. a legacy BIFF8 `.xls`, wearing an `.xlsx` filename.
That is simply what ABN AMRO's "Excel" download produces; they never moved to
OOXML. `file(1)` reports `CDFV2 Microsoft Excel`.

This is decisive for the library choice: **exceljs cannot read BIFF8 at all.**
Only SheetJS reads both the legacy container and modern OOXML.

The second finding makes the work much smaller than it looks. The sheet's
columns are identical to the TSV export `abn-tsv.ts` already parses:

```
Rekeningnummer  Muntsoort  Transactiedatum  Rentedatum  Beginsaldo  Eindsaldo  Transactiebedrag  Omschrijving
```

Same order, same `YYYYMMDD` dates, same free-text `Omschrijving` that the
existing `/NAME/` and `Naam:` regexes mine. Two differences only: the sheet has
a header row (the TSV has none), and amounts use a dot decimal rather than a
comma — which `decimalToCents` already accepts (`money.ts:7`).

**So there is no new statement parser to write.** There is a new container to
open, feeding row logic that already exists and is already tested.

### Verified before approval, not assumed

A throwaway probe read the real file with SheetJS 0.20.3 from the CDN, re-emitted
its rows in the exact shape `parseAbnTsv` eats, and ran the real parser:

```
parsed rows: 314 | errors: 0
counterpartyName: 145 | iban: 144 | mandate: 115 of 314
date range: 2026-04-02 -> 2026-07-29
```

Zero parse errors on the first attempt. The probe also confirmed the constraint
that matters most (see *String math* below): with `raw: false`, every cell comes
back as a **string** — `"20260402"`, `"-8.60"` — never a JavaScript number.

## Scope decisions (approved)

| Decision | Choice |
|---|---|
| Library | SheetJS `xlsx`, pinned to the **CDN tarball** `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`. 0.20.3 is the newest published there (0.20.4+ return 404) |
| Why not npm | The npm `xlsx` package is frozen at 0.18.5 with open advisories; maintained releases ship only from SheetJS's own CDN. These are mail attachments parsed server-side, so the patched build is the only defensible choice |
| Preview rendering | Server-rendered HTML table. **Not** a rasterized screenshot |
| New statement source | `abn-xls`, reusing the existing ABN row mapping rather than a parallel parser |
| Parser location | `@verder/parsers` — it already houses `abn-tsv`, `camt053`, `paypal-csv` |
| Search/extraction | New `sheet` extractor, so spreadsheets become findable and minable like every other document |

### Why a table and not a screenshot

The original request suggested rasterizing the sheet and overlaying an Excel
icon. A screenshot of a spreadsheet is the worst available version of a
spreadsheet: not selectable, not ⌘F-able, not scrollable past the fold — and for
a 314-row bank statement, that is the whole document. It is also *more*
machinery, not less: LibreOffice headless in the worker image (~400 MB), a
render job, somewhere to store the PNG, and cache invalidation.

An HTML table is less code and strictly better output. The icon card survives as
the fallback for genuinely un-renderable types, which is the job it is good at.

## String math is a project law

`money.ts` opens with *"STRING math only — this module never runs
parseFloat/Number arithmetic on fractional euros, so `19,99` is always 1999 and
never 1998.9999…"*.

A spreadsheet cell holds a binary float. Handing `decimalToCents` a JS number
`-8.6` would launder a float through a module built specifically to keep floats
out, and would do it silently. Therefore:

> `readWorkbook` reads **formatted cell text** (`raw: false`), never cell values.
> This is not a preference; it is the condition under which the sheet path is
> allowed to reuse the money code at all.

The probe confirms `-8.60` arrives with its trailing zero intact, so the format
carries two decimals. Even a one-decimal format is safe — `decimalToCents`
handles `tail.length === 1` by padding.

## Components

### 1. `packages/parsers/src/sheet.ts` — the container

```ts
readWorkbook(buf: Buffer): { name: string; rows: string[][] }[]
```

The **only** module in the monorepo that imports SheetJS. Reads every sheet as
formatted text with blank cells preserved (`defval: ""`) so column indices never
shift, and blank rows dropped. Handles both BIFF8 and OOXML because SheetJS
sniffs the container itself.

Keeping the dependency behind one function means a future library swap touches
one file, and means the security surface of parsing untrusted workbooks has
exactly one entry point.

### 2. `abn-tsv.ts` refactor + `parseAbnSheet`

Extract the per-row mapping now inlined in `parseAbnTsv`'s loop:

```ts
abnRowToParsed(cols: string[], rowIndex: number): ParsedRow   // throws per-row, as today
```

`parseAbnTsv` keeps its current behaviour (split latin-1 lines on tabs, feed the
mapping). `parseAbnSheet` reads sheet 1 via `readWorkbook`, drops the first row
when `cols[0] === "Rekeningnummer"`, and feeds the same mapping. Both keep the
existing contract: malformed rows land in `errors` with their raw text, never
dropped, never thrown.

The header check is on content, not position — a future export without a header
row must still import.

### 3. `detectSource` gains binary branches

`types.ts:26` currently does `head.toString("utf8")` and looks for tabs, XML, or
CSV headers. Handed an OLE2 container it finds none of them and returns `null` —
this is precisely the *"Unrecognized statement format"* error. It gains:

- OLE2: `d0cf11e0a1b11ae1` → `abn-xls`
- OOXML: `PK\x03\x04` **and** the buffer contains `xl/workbook.xml` → `abn-xls`

The ZIP check needs both halves: `PK` alone matches `.docx`, `.odt`, and any
plain zip, and misrouting those into a statement parser would register junk rows
against the registry.

Binary detection runs **first**, before the existing text heuristics — content
wins over extension, which is already this function's documented rule.

**Call site fix — measured, not guessed.** `registry-import.ts:51` passes
`buf.subarray(0, 1024)`. OLE2 magic sits in the first 8 bytes and is unaffected,
but a ZIP stores its entry names throughout the file: in a *minimal* generated
workbook `xl/workbook.xml` already sits at byte offset **11198**, and a real one
puts it further still. No fixed head slice is reliable — an earlier draft of
this spec said 8 KB and was wrong.

The head slice is therefore dropped: `detectSource` and `sniffContainer` receive
the **whole buffer**. There is no cost argument for slicing — every caller
already holds the complete file in memory (`registry-import.ts:45`,
`extract.ts`, the files route), `Buffer.includes` is a `memmem` scan, and
uploads are capped at 50 MB (`MAX_UPLOAD_BYTES`).

`StatementSource` gains `"abn-xls"`, and `PARSERS` a matching entry.

`MIME` needs one shape change. It is currently `Record<StatementSource, string>`
(`registry-import.ts:31`), which assumes one content type per source — but
`abn-xls` covers two containers, and recording a real `.xlsx` as
`application/vnd.ms-excel` would then feed the preview and the extractor a mime
that contradicts the bytes. So for `abn-xls` the recorded mime comes from the
sniffer that already ran, not from the source: `application/vnd.ms-excel` for
OLE2, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` for
OOXML. The other three sources keep their fixed mapping.

The sniff itself lives in one shared helper — `sniffContainer(buf)` in
`@verder/parsers`, which the worker already depends on — called by
`detectSource`, by `registry-import`, by `extract.ts`, and by the files route.
Four consumers, one copy of the magic bytes. `detectSource` keeps its current
signature, so no existing caller or test changes.

### 4. `apps/web/src/components/document-preview.tsx`

One component replacing the two-way `if` currently duplicated in
`vault/[id]/page.tsx:14` and `suggestion-card.tsx:261`:

| Content | Rendering |
|---|---|
| `image/*` | `<img>` (as today) |
| `application/pdf` | `<iframe>` (as today) |
| spreadsheet | server-rendered `<table>`, first sheet, capped at 200 rows, with *"showing first 200 of 314 rows"* |
| anything else | icon card: filename, size, detected type |

Every case also gets a **Download** button. There is none today — the download
the user saw was the `<iframe>` giving up on `application/octet-stream`.

The row cap is not decoration: a 50,000-row workbook rendered as `<tr>` elements
would hang the browser tab, and the queue card variant renders at `h-48` where
even 200 rows is far past what is readable.

### 5. `apps/worker/src/extract.ts` — sheets become searchable

`sniffMime` (`extract.ts:100`) knows PDF, PNG, and JPEG. It delegates to the
shared `sniffContainer` so the two spreadsheet containers are recognized here
too, and keeps its existing rule of consulting the bytes only when the recorded
mime is uninformative — a recorded `application/pdf` is still trusted as before.

A new `"sheet"` extractor flattens every sheet to tab-separated text
(`## <sheet name>` heading per sheet, so multi-sheet workbooks stay legible in
search results), then passes through the existing `cap()` at `MAX_TEXT_CHARS`.
The `Extractor` union gains `"sheet"`.

This is what moves the file out of `extractor: none, char_count: 0` and into
search, the `registry.mine` sweep, and the "do we already have this?" panel.

### 6. `/api/files/[sha256]`

Serves the stored mime verbatim (`route.ts:13`), so a document recorded as
`application/octet-stream` downloads no matter what it really is. When the
stored mime is uninformative, the route sniffs the bytes and serves the detected
type with `Content-Disposition: inline`.

This calls the same `sniffContainer` rather than adding another copy of the
magic bytes.

## Error handling

- A workbook SheetJS cannot open: `readWorkbook` throws; `parseAbnSheet` surfaces
  it as a `BAD_REQUEST` through the existing ingest path, and the file **stays
  registered as evidence** — `registry-import.ts:55` already writes the document
  and ledger event before judging the format, and that ordering is preserved.
- A workbook that opens but has the wrong columns: rows fail the existing
  8-column and currency checks and land in `errors` with raw text, exactly as a
  malformed TSV line does today.
- Extraction never throws (`extract.ts:136`); a sheet that will not open is
  recorded as `extractor: none` with the reason in `worker_runs`, and the
  document stays findable by title.
- Preview parse failure falls back to the icon card plus Download, never a blank
  frame.

## Deployment

1. `pnpm install` picks up the CDN tarball; worker and web images rebuild.
2. No migration — `document_texts.extractor` is a text column, not an enum.
3. `pnpm --filter worker extract-texts` backfills the two existing
   `application/octet-stream` documents (idempotent, and it already retries
   anything stored as `none` on a readable mime).
4. `pnpm --filter worker reindex` so the newly extracted text reaches
   `search_chunks`.

## Testing

- `readWorkbook`: fixtures for BIFF8 and OOXML asserting formatted-text cells
  (`"-8.60"` as a string, never `-8.6` as a number) and preserved column
  indices across blank cells. Fixtures are **small synthetic workbooks**, never
  Martin's real statement, and follow the existing
  `apps/worker/src/fixtures/make-fixtures.sh` convention: generated by a
  committed script (SheetJS writes both `bookType: "biff8"` and `"xlsx"`) so
  they are reproducible rather than mysterious binaries.
- `parseAbnSheet` vs `parseAbnTsv`: the same eight columns through both paths
  produce identical `ParsedRow`s. This is the test that guards the refactor.
- Header handling: present and absent both import; a header row is never
  imported as a transaction.
- `detectSource`: OLE2 → `abn-xls`; OOXML-with-`xl/` → `abn-xls`; a plain zip and
  a `.docx` → `null`, not a statement.
- `sniffMime`: the same cases, plus the existing PDF/PNG/JPEG cases unregressed.
- `document-preview`: a render test per branch, including the row cap and the
  fallback card.
- Ingest: an `.xls` upload produces rows, is idempotent on re-upload, and a
  corrupt workbook still registers the document and its ledger event.

## Known characteristics (not regressions)

Measured on the real file, through the existing parser: SEPA rows resolve their
counterparty perfectly (142 of 142 — 109 slash-format, 33 label-format), while
**126 BEA card/Apple Pay rows and 4 GEA ATM rows resolve none**. The merchant
name is present in those descriptions but in a shape the current regexes do not
match.

That is a pre-existing property of `abn-tsv.ts`, unchanged by this work, and it
will apply identically to TSV imports. Recorded here because 40% of a real
statement is card payments, and `registry.mine`'s recurring-charge detection is
weaker than it looks until BEA descriptions are mined too.

## Out of scope

- **BEA/GEA description mining** — the follow-up implied above. Own change,
  own evidence, own eval.
- **Cross-format duplicate detection.** Importing both the `.tsv` and the `.xls`
  for one period double-counts, because idempotency keys on
  `(statementSha256, rowIndex)` and those are different files. `transactions` is
  currently empty, so there is no live risk today; deduplicating on
  `(bookedAt, amountCents, description)` is a separate design.
- Editing spreadsheets, multi-sheet tab switching in the preview, `.ods`,
  and rasterized thumbnails of any kind.
