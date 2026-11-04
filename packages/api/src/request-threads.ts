/**
 * VRAAG GRIP AS MARTIN SEES IT: ONE ROW PER THREAD (the final Figma frames,
 * "Vraag Grip · it6", 2026-11-04).
 *
 * A thread is a request and its follow-ups ("Vraag door"). Voor jou shows it
 * ONCE, by its HEAD — the newest member that was not stopped — and the head
 * carries everything the thread still asks of Martin: an unread answer, the
 * steps only he can do, the proposal it drafted, or a failure he must retry or
 * drop. Pure: no DB. `loadWaiting` (what counts) and `requests.list` (what the
 * phone lists) both read this, so the badge, the list and the answer screen
 * cannot disagree about where a question stands.
 *
 * THE FOLDING RULE: a pending proposal a request drafted is carried by the
 * request's own row. It is NOT listed or counted separately — "Boedel-
 * beschrijving Noordkust · nieuw antwoord · 1 voorstel" is one thing waiting,
 * not two. Only "Laat maar" (dismissing the thread) RELEASES that proposal as a
 * standalone Voor jou row ("Voor jou · na Laat maar"): the question is put
 * away, the mail it prepared still waits, and the count stays the same.
 *
 * A FAILED request waits on Martin: his next step is "Opnieuw proberen" or
 * "Laat maar", and until he takes one it counts ("Voor jou · lukte niet").
 *
 * While a follow-up is queued or being researched, the thread waits on GRIP,
 * not on him, even when an earlier answer's proposal is still pending: that
 * proposal is being rewritten ("voorstel wordt bijgewerkt"), and offering
 * version 1 for Face ID while version 2 is being drafted is how the wrong mail
 * gets sent.
 */

export type RequestPhase = "queued" | "working" | "updating" | "todo" | "done";
/** Why a `todo` thread waits on Martin, most pressing first. */
export type RequestTodoReason = "failed" | "unread" | "steps" | "proposal";
/** How a `done` thread ended, as Eerdere vragen names it. */
export type RequestDoneReason = "afgerond" | "beantwoord" | "weggelegd" | "gestopt";

/** One request row, as the loaders read it. */
export interface RequestThreadRow {
  id: string;
  parentRequestId: string | null;
  text: string;
  title: string | null;
  status: string;
  createdAt: Date;
  answeredAt: Date | null;
  openedAt: Date | null;
  dismissedAt: Date | null;
  updatedAt: Date;
  martinSteps: string[];
  /** {"<index>": iso} — Martin's ticks. */
  stepsDone: Record<string, string>;
  /** The proposal THIS request drafted, if any. */
  proposal: { id: string; status: string; priority: string } | null;
}

export interface RequestThread {
  /** The member Voor jou shows and the answer screen opens. */
  head: RequestThreadRow;
  root: RequestThreadRow;
  /** Every member, oldest first. */
  members: RequestThreadRow[];
  phase: RequestPhase;
  todoReason: RequestTodoReason | null;
  doneReason: RequestDoneReason | null;
  /** The thread's pending proposal (folded into its row), or null. */
  carried: { id: string; status: string; priority: string } | null;
  /** A pending proposal "Laat maar" released as a row of its own. */
  released: { id: string; priority: string } | null;
  stepsTotal: number;
  stepsDone: number;
  /** The moment the row shows: answered, failed, stopped, put away or finished. */
  at: Date;
  /** The thread's name: the root's title, else Martin's own words. */
  title: string;
}

const TITLE_MAX = 120;

const byCreated = (a: RequestThreadRow, b: RequestThreadRow) =>
  a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Martin's own words as a one-line name, whitespace folded, clipped. */
export function requestName(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

/** The ticked indices that name a step that exists. */
export function doneSteps(r: Pick<RequestThreadRow, "martinSteps" | "stepsDone">): number[] {
  return Object.keys(r.stepsDone ?? {})
    .map((k) => Number(k))
    .filter((i) => Number.isInteger(i) && i >= 0 && i < r.martinSteps.length)
    .sort((a, b) => a - b);
}

/**
 * A failed request that "Opnieuw proberen" replaced: put away, and a newer
 * request with the same words under the same parent exists. It is not a
 * question Martin put away; it is not shown at all.
 */
function retriedAway(r: RequestThreadRow, all: RequestThreadRow[]): boolean {
  return r.status === "failed" && r.dismissedAt !== null && all.some((o) =>
    o.id !== r.id && o.parentRequestId === r.parentRequestId && o.text === r.text
    && o.createdAt.getTime() >= r.createdAt.getTime());
}

export function requestThreads(rows: readonly RequestThreadRow[]): RequestThread[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const rootOf = (r: RequestThreadRow): RequestThreadRow => {
    let cur = r;
    const seen = new Set<string>([cur.id]);
    while (cur.parentRequestId) {
      const p = byId.get(cur.parentRequestId);
      if (!p || seen.has(p.id)) break;
      seen.add(p.id);
      cur = p;
    }
    return cur;
  };
  const groups = new Map<string, RequestThreadRow[]>();
  for (const r of rows) {
    const root = rootOf(r);
    const g = groups.get(root.id) ?? [];
    g.push(r);
    groups.set(root.id, g);
  }

  const out: RequestThread[] = [];
  for (const [rootId, raw] of groups) {
    const members = [...raw].sort(byCreated);
    const visible = members.filter((m) => !retriedAway(m, rows as RequestThreadRow[]));
    if (visible.length === 0) continue;
    const root = byId.get(rootId)!;
    // A stopped follow-up hands the thread back to the answer it followed.
    const live = visible.filter((m) => m.status !== "cancelled" || m.parentRequestId === null);
    const head = (live.length ? live : visible)[(live.length ? live : visible).length - 1];
    // The newest member that drafted a proposal decides the thread's proposal:
    // a follow-up's new version replaces the one before it.
    const drafter = [...visible].reverse().find((m) => m.proposal !== null) ?? null;
    const carried = drafter?.proposal?.status === "pending" ? drafter.proposal : null;
    const done = doneSteps(head);
    const stepsTotal = head.status === "answered" ? head.martinSteps.length : 0;
    const stepsDone = head.status === "answered" ? done.length : 0;
    const openSteps = stepsTotal - stepsDone;
    const lastTick = done.map((i) => new Date(head.stepsDone[String(i)])).filter((d) => !Number.isNaN(d.getTime()))
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

    let phase: RequestPhase;
    let todoReason: RequestTodoReason | null = null;
    let doneReason: RequestDoneReason | null = null;
    let at: Date;
    if (head.dismissedAt) {
      phase = "done"; doneReason = "weggelegd"; at = head.dismissedAt;
    } else if (head.status === "queued" || head.status === "working") {
      phase = carried ? "updating" : head.status; at = head.createdAt;
    } else if (head.status === "failed") {
      phase = "todo"; todoReason = "failed"; at = head.updatedAt;
    } else if (head.status === "cancelled") {
      phase = "done"; doneReason = "gestopt"; at = head.updatedAt;
    } else {
      const answeredAt = head.answeredAt ?? head.updatedAt;
      if (head.openedAt === null) { phase = "todo"; todoReason = "unread"; at = answeredAt; }
      else if (openSteps > 0) { phase = "todo"; todoReason = "steps"; at = answeredAt; }
      else if (carried) { phase = "todo"; todoReason = "proposal"; at = answeredAt; }
      else {
        phase = "done";
        doneReason = stepsTotal > 0 ? "afgerond" : "beantwoord";
        at = stepsTotal > 0 && lastTick ? lastTick : answeredAt;
      }
    }
    out.push({
      head, root, members: visible, phase, todoReason, doneReason,
      carried: phase === "done" ? null : carried,
      released: head.dismissedAt && carried ? { id: carried.id, priority: carried.priority } : null,
      stepsTotal, stepsDone, at,
      title: requestName(root.title ?? root.text),
    });
  }
  return out.sort((a, b) => b.at.getTime() - a.at.getTime() || (a.head.id < b.head.id ? -1 : 1));
}

/**
 * The row's meta, in Dutch sentence case (the phone sets it in caps):
 * "Nieuw antwoord · 1 voorstel", "1 voorstel · 1 stap voor jou",
 * "Lukte niet · Opnieuw". Only for a `todo` thread.
 */
export function requestTodoMeta(t: Pick<RequestThread, "todoReason" | "carried" | "stepsTotal" | "stepsDone">): string {
  const open = t.stepsTotal - t.stepsDone;
  const steps = open > 0 ? `${open} ${open === 1 ? "stap" : "stappen"} voor jou` : null;
  const proposal = t.carried ? "1 voorstel" : null;
  if (t.todoReason === "failed") return "Lukte niet · Opnieuw";
  // Unread: the news first, then the one thing it brought that waits most.
  if (t.todoReason === "unread") return ["Nieuw antwoord", proposal ?? steps].filter(Boolean).join(" · ");
  return [proposal, steps].filter(Boolean).join(" · ") || "Beantwoord";
}

/** One thread as the phone lists it: its head's facts and the thread's state. */
export function requestListItem(t: RequestThread) {
  const r = t.head;
  return {
    id: r.id, rootId: t.root.id, text: r.text, title: t.title, status: r.status,
    phase: t.phase, todoReason: t.todoReason, doneReason: t.doneReason,
    /** The row's meta while it waits on Martin ("Nieuw antwoord · 1 voorstel"). */
    meta: t.phase === "todo" ? requestTodoMeta(t) : null,
    parentRequestId: r.parentRequestId,
    createdAt: r.createdAt, answeredAt: r.answeredAt, openedAt: r.openedAt, dismissedAt: r.dismissedAt,
    at: t.at,
    /** Answered and not yet opened. */
    unread: r.status === "answered" && r.openedAt === null && !r.dismissedAt,
    stepsTotal: t.stepsTotal, stepsDone: t.stepsDone,
    /** The thread's pending proposal (folded into this row) or, after "Laat
     *  maar", the one it released; else the newest a member drafted. */
    proposal: t.carried ?? (t.released ? { id: t.released.id, status: "pending", priority: t.released.priority } : null)
      ?? (() => {
        const p = [...t.members].reverse().find((m) => m.proposal)?.proposal;
        return p ? { id: p.id, status: p.status, priority: p.priority } : null;
      })(),
    followUps: t.members.length - 1,
  };
}

