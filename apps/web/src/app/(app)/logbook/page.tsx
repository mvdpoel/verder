import Link from "next/link";
import { buttonClass, Empty, PageTitle, Panel, Row } from "@/components/ui";
import { serverCaller } from "@/lib/trpc-server";

export default async function LogbookPage() {
  const caller = await serverCaller();
  const entries = await caller.entries.list({ limit: 100 });
  return (
    <div>
      <div className="mb-7 flex flex-wrap items-end justify-between gap-5">
        <PageTitle className="leading-none">
          Logbook
        </PageTitle>
        <Link href="/logbook/new" className={buttonClass("primary")}>
          + Log a contact moment
        </Link>
      </div>
      {entries.length === 0 ? (
        <Empty title="Nothing logged yet — your first entry is one click away. 💪" />
      ) : (
        <Panel lit className="px-[26px] py-[6px]">
          {entries.map((e) => (
            <Row
              key={e.id}
              /*
               * Steel, always: every entry is something that already happened.
               * A log row is never "waiting on Martin", so no row here may be
               * amber — that mark belongs to the tasks and stops that are.
               */
              state="done"
              title={
                <Link
                  href={`/logbook/${e.id}`}
                  className="transition-colors hover:text-signal-link">
                  {e.summary}
                </Link>
              }
              kicker={`${e.channel} · ${e.direction} · ${new Date(e.occurredAt).toLocaleString("nl-NL")}`}
              meta={e.supersedesId ? "correction" : undefined}
            />
          ))}
        </Panel>
      )}
    </div>
  );
}
