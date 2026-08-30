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
  const [pending, manual] = await Promise.all([
    caller.suggestions.list({ status: "pending" }),
    caller.suggestions.list({ status: "needs-manual" }),
  ]);
  const all = [...pending, ...manual];
  return (
    <div className="flex max-w-2xl flex-col gap-7">
      <PageTitle>Te beoordelen</PageTitle>
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
