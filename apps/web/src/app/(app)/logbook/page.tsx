import Link from "next/link";
import { buttonClass, Empty, PageTitle, Panel, Row } from "@/components/ui";
import { serverCaller } from "@/lib/trpc-server";
import { CHANNEL_LABEL, DIRECTION_LABEL } from "@/lib/entry-labels";

export default async function LogbookPage() {
  const caller = await serverCaller();
  const entries = await caller.entries.list({ limit: 100 });
  return (
    <div>
      <div className="mb-7 flex flex-wrap items-end justify-between gap-5">
        <PageTitle className="leading-none">
          Logboek
        </PageTitle>
        <Link href="/logbook/new" className={buttonClass("primary")}>
          + Contactmoment vastleggen
        </Link>
      </div>
      {entries.length === 0 ? (
        <Empty title="Nog niets vastgelegd — je eerste regel is één klik weg. 💪" />
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
              kicker={`${CHANNEL_LABEL[e.channel] ?? e.channel} · ${DIRECTION_LABEL[e.direction] ?? e.direction} · ${new Date(e.occurredAt).toLocaleString("nl-NL")}`}
              meta={e.supersedesId ? "correctie" : undefined}
            />
          ))}
        </Panel>
      )}
    </div>
  );
}
