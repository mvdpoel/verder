import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";
import { SearchFilters } from "@/components/search-filters";
import { SearchResults } from "@/components/search-results";
import {
  buildSearchHref, parseSearchParams, semanticNotice, toQueryInput,
} from "@/lib/search-url";

// Everything on this page comes from the URL and is rendered on the server, so
// a bookmarked or shared /search?q=… link reproduces exactly this view with
// JavaScript disabled. The ⌘K palette is the fast path; this is the durable one.

export default async function SearchPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parsed = parseSearchParams(await searchParams);
  const caller = await serverCaller();
  const parties = await caller.parties.list();
  // The router requires q of at least one character, so an empty box asks nothing.
  const result = parsed.q ? await caller.search.query(toQueryInput(parsed)) : null;
  const notice = result ? semanticNotice(result) : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Search</h1>
        <p className="text-slate-600 mt-1">
          Everything in the dossier — documents, logbook, e-mail, registry, tasks
          — in one place. Every result says why it matched.
        </p>
      </div>

      <SearchFilters parsed={parsed}
        parties={parties.map((p) => ({ id: p.id, name: p.name }))} />

      {notice && (
        <p className="rounded border border-amber-200 bg-amber-50 p-2 text-sm text-amber-800">
          {notice}
        </p>
      )}

      {result ? (
        <>
          <SearchResults hits={result.hits} />
          <div className="flex items-center gap-3">
            {result.nextCursor && (
              <Link className="inline-block rounded border px-4 py-2 hover:bg-slate-100"
                href={buildSearchHref(parsed, { cursor: result.nextCursor })}>
                More results →
              </Link>
            )}
            {parsed.cursor && (
              <Link className="text-sm text-slate-500 hover:underline"
                href={buildSearchHref(parsed, { cursor: null })}>
                back to the first page
              </Link>
            )}
          </div>
        </>
      ) : (
        <p className="text-slate-500">
          Type something above — or press ⌘K anywhere in the app.
        </p>
      )}
    </div>
  );
}
