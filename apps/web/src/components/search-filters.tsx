import { SEARCH_ENTITY_TYPES } from "@verder/core";
import { ENTITY_LABEL, STATUS_FILTERS } from "./search-kinds";
import type { ParsedSearch } from "@/lib/search-url";

// A plain GET form: no client state, no JavaScript. Submitting reloads /search
// with the filters in the URL — which is exactly what a bookmarked or shared
// search needs in order to reproduce itself. The cursor is deliberately not a
// field: changing a filter starts a new search at the first page.

export function SearchFilters({ parsed, parties }: {
  parsed: ParsedSearch; parties: { id: string; name: string }[];
}) {
  return (
    <form method="get" action="/search" className="rounded border bg-white p-4 space-y-3">
      <label className="block text-sm">Search
        <input name="q" defaultValue={parsed.q} placeholder="opzegging Ziggo"
          className="w-full border rounded p-2" />
      </label>
      <fieldset className="space-y-1">
        <legend className="text-sm">Type</legend>
        <div className="flex flex-wrap gap-3">
          {SEARCH_ENTITY_TYPES.map((t) => (
            <label key={t} className="text-sm flex items-center gap-1">
              <input type="checkbox" name="type" value={t}
                defaultChecked={parsed.entityTypes.includes(t)} />
              {ENTITY_LABEL[t]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-3">
        <label className="text-sm">From
          <input type="date" name="from" defaultValue={parsed.from}
            className="block border rounded p-2" />
        </label>
        <label className="text-sm">To
          <input type="date" name="to" defaultValue={parsed.to}
            className="block border rounded p-2" />
        </label>
        <label className="text-sm">Party
          <select name="party" defaultValue={parsed.partyId} className="block border rounded p-2">
            <option value="">Anyone</option>
            {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="text-sm">Status
          <select name="status" defaultValue={parsed.status} className="block border rounded p-2">
            <option value="">Any status</option>
            {STATUS_FILTERS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
      </div>
      <button type="submit" className="rounded bg-slate-900 text-white px-4 py-2">Search</button>
    </form>
  );
}
