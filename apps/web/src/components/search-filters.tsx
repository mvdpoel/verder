import { SEARCH_ENTITY_TYPES } from "@verder/core";
import { Button, Field, Input, Label, Panel, Select } from "@/components/ui";
import { ENTITY_LABEL, STATUS_FILTERS } from "./search-kinds";
import type { ParsedSearch } from "@/lib/search-url";

// A plain GET form: no client state, no JavaScript. Submitting reloads /search
// with the filters in the URL — which is exactly what a bookmarked or shared
// search needs in order to reproduce itself. The cursor is deliberately not a
// field: changing a filter starts a new search at the first page.

/**
 * The type filter reads as a row of chips that light up when they are on, but it
 * is still nine real checkboxes inside a GET form — the toggle is CSS (`has-`)
 * over the checked state, so it costs no JavaScript and keeps the keyboard and
 * screen-reader behaviour the browser already gives. The box itself stays
 * visible: if `has-` ever fails to compile, the checked state is still readable.
 */
const TYPE_CHIP = [
  "inline-flex cursor-pointer items-center gap-[8px] rounded-chip border border-edge",
  "px-[10px] py-[6px] font-mono text-[9.5px] tracking-[0.14em] uppercase",
  "text-ink-dim transition-colors hover:border-edge-strong hover:text-ink-soft",
  "has-[:checked]:border-signal/45 has-[:checked]:text-signal",
].join(" ");

export function SearchFilters({ parsed, parties }: {
  parsed: ParsedSearch; parties: { id: string; name: string }[];
}) {
  return (
    <Panel lit>
      <form method="get" action="/search" className="flex flex-col gap-[22px] p-[26px]">
        <Field label="Zoekterm" htmlFor="search-q">
          <Input id="search-q" name="q" defaultValue={parsed.q} placeholder="opzegging Ziggo" />
        </Field>

        <fieldset className="flex flex-col gap-[10px]">
          <Label as="legend">Soort</Label>
          <div className="flex flex-wrap gap-[8px]">
            {SEARCH_ENTITY_TYPES.map((t) => (
              <label key={t} className={TYPE_CHIP}>
                <input type="checkbox" name="type" value={t}
                  className="size-[13px] accent-signal"
                  defaultChecked={parsed.entityTypes.includes(t)} />
                {ENTITY_LABEL[t]}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid gap-[16px] sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Van" htmlFor="search-from">
            <Input id="search-from" type="date" name="from" defaultValue={parsed.from} />
          </Field>
          <Field label="Tot en met" htmlFor="search-to">
            <Input id="search-to" type="date" name="to" defaultValue={parsed.to} />
          </Field>
          <Field label="Partij" htmlFor="search-party">
            <Select id="search-party" name="party" defaultValue={parsed.partyId}>
              <option value="">Iedereen</option>
              {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label="Status" htmlFor="search-status">
            <Select id="search-status" name="status" defaultValue={parsed.status}>
              <option value="">Elke status</option>
              {STATUS_FILTERS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </Select>
          </Field>
        </div>

        <div className="flex items-center">
          <Button type="submit" variant="primary">Zoeken</Button>
        </div>
      </form>
    </Panel>
  );
}
