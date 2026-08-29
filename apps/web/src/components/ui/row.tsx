import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * The marks, and what they mean. This list is the map's legend AND the legend
 * for every list in the app — the same dot has to say the same thing everywhere.
 *
 *   done      filled steel      it happened
 *   open      cyan ring         a stop that is still running
 *   you       filled amber      this waits on YOU (the only glowing dot)
 *   waiting   dim fill          it waits on someone else
 *   junction  dim cyan ring     another track leaves from or lands on this
 *   ok        filled mint       system healthy
 */
export type DotState = "done" | "open" | "you" | "waiting" | "junction" | "ok";

const DOT: Record<DotState, string> = {
  done: "bg-steel",
  open: "border border-signal",
  you: "bg-attn shadow-attn",
  waiting: "bg-edge-strong",
  junction: "border border-signal/55",
  ok: "bg-okay shadow-okay",
};

export function Dot({ state, className }: { state: DotState; className?: string }) {
  return <span className={cx("size-[9px] shrink-0 rounded-full box-border", DOT[state], className)} />;
}

/**
 * The standard row: dot, title with a mono kicker under it, and on the right
 * whatever has been measured about it. The separator is a hairline UNDER every
 * row but the last — hence `last:border-0` rather than a line on top.
 */
export function Row({
  state, title, kicker, meta, metaTone = "dim", className,
}: {
  state?: DotState;
  title: ReactNode;
  kicker?: ReactNode;
  meta?: ReactNode;
  metaTone?: "dim" | "attn" | "signal";
  className?: string;
}) {
  return (
    <div className={cx("flex items-center gap-4 border-b border-hairline py-[13px] last:border-0", className)}>
      {state ? <Dot state={state} /> : null}
      <div className="min-w-0 grow">
        <div className="text-sm text-ink-soft">{title}</div>
        {kicker ? <div className="micro mt-[3px]">{kicker}</div> : null}
      </div>
      {meta ? (
        <div
          className={cx(
            "shrink-0 font-mono text-[10px] tracking-[0.14em] uppercase",
            metaTone === "attn" && "text-attn",
            metaTone === "signal" && "text-signal",
            metaTone === "dim" && "text-ink-dim",
          )}
        >
          {meta}
        </div>
      ) : null}
    </div>
  );
}
