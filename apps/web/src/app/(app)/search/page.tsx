import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";
import { buttonClass, Empty, Notice, PageTitle, TextLink } from "@/components/ui";
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
  // The router requires q of at least one character, so an empty box asks
  // nothing — and the party list for the filters does not depend on the query,
  // so the two go out together.
  const [parties, result] = await Promise.all([
    caller.parties.list(),
    parsed.q ? caller.search.query(toQueryInput(parsed)) : null,
  ]);
  const notice = result ? semanticNotice(result) : null;

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-[10px]">
        <PageTitle>
          Zoeken
        </PageTitle>
        <p className="max-w-2xl text-[14.5px] font-light leading-relaxed text-ink-mute">
          Alles in het dossier — documenten, logboek, e-mail, register, taken —
          op één plek. Bij elk resultaat staat waaróm het gevonden is.
        </p>
      </div>

      <SearchFilters parsed={parsed}
        parties={parties.map((p) => ({ id: p.id, name: p.name }))} />

      {/*
        Half the index being unreachable is the system reporting on itself, not
        something waiting on Martin — the notice says in so many words that
        nothing is lost — so it is cyan and never amber.
      */}
      {notice && <Notice tone="signal">{notice}</Notice>}

      {result ? (
        <>
          <SearchResults hits={result.hits} />
          <div className="flex items-center gap-[18px]">
            {result.nextCursor && (
              <Link className={buttonClass("ghost", "sm")}
                href={buildSearchHref(parsed, { cursor: result.nextCursor })}>
                Meer resultaten →
              </Link>
            )}
            {parsed.cursor && (
              <TextLink
                className="font-mono text-[10px] tracking-[0.14em] uppercase"
                href={buildSearchHref(parsed, { cursor: null })}>
                terug naar de eerste pagina
              </TextLink>
            )}
          </div>
        </>
      ) : (
        <Empty title="Typ hierboven iets — of druk ⌘K, waar je ook bent in de app." />
      )}
    </div>
  );
}
