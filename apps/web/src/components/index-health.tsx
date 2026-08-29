import type { IndexHealth } from "@verder/api/src/search/health";
import { indexHealthState, type IndexHealthTone } from "@/lib/index-health-state";
import { Callout, cx, Label, Panel } from "@/components/ui";

// Server-safe card. Sits beside the ledger checks on /verify so a stalled index
// is as visible as a broken chain — with the difference spelled out: the index
// is derived and rebuildable, the chain is the evidence.

/*
 * The verdict's colour is a judgement about WHO the state waits on, not a
 * severity ramp — which is why `warn` is cyan and not amber. A queue that is
 * draining and an embedding that will be retried are the system working on its
 * own; amber there would claim Martin owes the index something. `bad` does wait
 * on him: the indexer is down and only he can start the worker back up.
 */
const TONE_TEXT: Record<IndexHealthTone, string> = {
  ok: "text-okay", warn: "text-signal", bad: "text-attn",
};
/*
 * The index's three states, mapped onto the system's three verdict tones. The
 * box itself is `Callout`, shared with the chain check beside it — the two were
 * hand-rolled with identical classes, which is how the two halves of one screen
 * start disagreeing about what a result looks like.
 */
const TONE_CALLOUT: Record<IndexHealthTone, "ok" | "signal" | "attn"> = {
  ok: "ok", warn: "signal", bad: "attn",
};

export function IndexHealthCard({ health, now }: { health: IndexHealth; now: number }) {
  const state = indexHealthState(health, now);
  return (
    <Panel>
      <div className="flex flex-col gap-4 p-[26px]">
        <Label as="h2">Search index</Label>
        <p className="max-w-prose text-[13.5px] font-light leading-relaxed text-ink-mute">
          The index is derived, never evidence: it can be rebuilt from the record at any
          time (<code className="rounded-chip bg-field px-[5px] py-[2px] font-mono text-[12px] text-ink-soft">pnpm --filter worker reindex</code>). A broken index can only fail
          to find something — it can never change what happened.
        </p>
        <Callout tone={TONE_CALLOUT[state.tone]} dot>
          <p className={cx("text-[13.5px] font-light leading-relaxed", TONE_TEXT[state.tone])}>{state.message}</p>
        </Callout>
        {/*
          The counts are measurements, so the figures are mono and the sentence
          around them is not. Hairlines under the rows, matching every other list
          in the app; the numbers stay ink whatever the verdict, because tinting
          a zero mint would be the card cheering for itself.
        */}
        <ul className="flex flex-col">
          <li className="border-b border-hairline py-[9px] text-[13px] font-light text-ink-mute last:border-0">
            <span className="font-mono text-[12.5px] text-ink">{health.chunks}</span> chunks indexed
          </li>
          <li className="border-b border-hairline py-[9px] text-[13px] font-light text-ink-mute last:border-0">
            <span className="font-mono text-[12.5px] text-ink">{health.embedFailures}</span> chunks waiting on a retry after a failed embedding
          </li>
          <li className="border-b border-hairline py-[9px] text-[13px] font-light text-ink-mute last:border-0">
            <span className="font-mono text-[12.5px] text-ink">{health.outboxDepth}</span> records waiting in the queue
          </li>
          <li className="border-b border-hairline py-[9px] text-[13px] font-light text-ink-mute last:border-0">
            Last index run:{" "}
            <span className="font-mono text-[12.5px] text-ink">
              {health.lastDrainAt
                ? new Date(health.lastDrainAt).toLocaleString("nl-NL")
                : "never"}
            </span>
          </li>
        </ul>
      </div>
    </Panel>
  );
}
