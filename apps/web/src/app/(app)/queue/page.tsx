import { serverCaller } from "@/lib/trpc-server";
import { SuggestionCard } from "@/components/suggestion-card";
import { Empty, PageTitle } from "@/components/ui";

/**
 * Everything on this page is AI output awaiting Martin's verdict, so nothing on
 * it is allowed to look like a fact already in the record: the cards carry the
 * system's own cyan, and the page itself stays out of the way — one light
 * heading, one line of explanation, then the proposals.
 *
 * The list keeps a reading measure rather than filling the width. A suggestion
 * is a form you read and correct, and a 1400px-wide input is not one.
 */
export default async function QueuePage() {
  const caller = await serverCaller();
  // Open verdicts only. An `auto-applied` suggestion (migration 0040) is
  // already decided — verder filed it — so it never appears as a card here;
  // it is listed under "Door verder gedaan", where it can be undone.
  const [pending, manual, waitingCount] = await Promise.all([
    caller.suggestions.list({ status: "pending" }),
    caller.suggestions.list({ status: "needs-manual" }),
    caller.inbox.count(),
  ]);
  const all = [...pending, ...manual];
  // This page lists suggestions only, so the whole-set count (tasks, proposals
  // and the open stop too — the number the phone's badge carries) is labelled
  // as the total, never as the length of the list below it.
  const totalLine = waitingCount > 0
    ? `${waitingCount} ${waitingCount === 1 ? "wacht" : "wachten"} op je in totaal`
    : null;
  return (
    <div className="flex max-w-2xl flex-col gap-7">
      <PageTitle>Te beoordelen</PageTitle>
      {totalLine ? (
        <p className="-mt-4 font-mono text-[10px] tracking-[0.14em] uppercase text-ink-dim">{totalLine}</p>
      ) : null}
      {all.length ? (
        <>
          <p className="text-sm font-light leading-relaxed text-ink-mute">
            {all.length === 1
              ? "1 voorstel wacht op je — jij bepaalt wat er in het dossier komt."
              : `${all.length} voorstellen wachten op je — jij bepaalt wat er in het dossier komt.`}
          </p>
          <ul className="flex flex-col gap-4">{all.map((s) => <SuggestionCard key={s.id} s={s} />)}</ul>
        </>
      ) : (
        <Empty title="Niets te beoordelen. Alles is afgehandeld — even ademhalen. ☕" />
      )}
    </div>
  );
}
