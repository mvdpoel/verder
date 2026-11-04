/**
 * Vraag Grip on the phone: the JSON the request routes serve
 * (spec docs/superpowers/specs/2026-11-04-vraag-grip-design.md, "Phone", and
 * the final Figma frames "Vraag Grip · it6").
 *
 * The router (`packages/api/src/routers/requests.ts`) decides what a request
 * shows; this file only fixes the wire shape — every instant an ISO string,
 * every absent value `null` — so the fixtures the simulator draws
 * (`mobile-requests.fixture.test.ts`) are this DTO over synthetic rows and
 * cannot drift from what the route serves. The sources are structural copies
 * of the router's output, as `mobile-dto.ts` does for its own.
 */

type When = Date | string | null | undefined;
const iso = (d: When): string | null => (d == null ? null : new Date(d).toISOString());

/** One THREAD as `requests.list` returns it (by its head). */
export interface RequestListSource {
  id: string; rootId: string; text: string; title: string; status: string;
  phase: string; todoReason: string | null; doneReason: string | null; meta: string | null;
  parentRequestId: string | null;
  createdAt: Date | string; answeredAt: When; openedAt: When; dismissedAt: When; at: Date | string;
  unread: boolean; stepsTotal: number; stepsDone: number;
  proposal: { id: string; status: string; priority: string } | null;
  followUps: number;
}

export interface RequestSourceDetail {
  type: string; id: string; why: string; label: string; meta: string[]; at: string | null; inDossier: boolean;
  transaction?: { amountCents: number; bookedAt: string; counterparty: string | null; accountIban: string | null;
    description: string | null; mandate: boolean };
  gmail?: { from: string; to: string; subject: string; date: string; body: string };
}

export interface ProposalCardSource {
  id: string; status: string; kind: string; priority: string; title: string | null;
  to: string[]; subject: string | null; attachmentCount: number; sentAt: When;
}

export interface RequestDetailSource {
  id: string; rootId: string; clientId: string; text: string; status: string; title: string; headline: string | null;
  phase: string | null; todoReason: string | null; doneReason: string | null;
  parentRequestId: string | null;
  createdAt: Date | string; claimedAt: When; answeredAt: When; openedAt: When; dismissedAt: When; updatedAt: Date | string;
  unread: boolean; progressLine: string | null; failure: string | null; failureDetail: string | null;
  about: { type: string; id: string; label: string; meta: string[]; at: string | null } | null;
  answer: string | null;
  sources: RequestSourceDetail[];
  martinSteps: string[];
  steps: { index: number; text: string; doneAt: string | null }[];
  proposal: ProposalCardSource | null;
  proposalUpdating: boolean;
  progress: { calls: number; documents: number; mails: number; gmail: number; line: string | null;
    steps: { label: string; state: string }[] } | null;
  thread: { id: string; text: string; status: string; createdAt: Date | string; title: string; headline: string | null;
    answer: string | null; proposal: ProposalCardSource | null }[];
  followUps: { id: string; text: string; status: string; createdAt: Date | string }[];
}

export interface RequestListItemDTO {
  /** The thread's HEAD: the member the answer screen opens. */
  id: string;
  rootId: string;
  text: string;
  /** The thread's name: the answer's title, else Martin's own words. */
  title: string;
  /** The head's status: queued · working · answered · failed · cancelled. */
  status: string;
  /** Where the thread stands: queued · working · updating (a follow-up is
   *  rewriting its proposal) · todo (waits on Martin) · done (Eerdere vragen). */
  phase: string;
  /** todo: failed · unread · steps · proposal. */
  todoReason: string | null;
  /** done: afgerond · beantwoord · weggelegd · gestopt. */
  doneReason: string | null;
  /** todo: the row's meta, "Nieuw antwoord · 1 voorstel". */
  meta: string | null;
  parentRequestId: string | null;
  createdAt: string; answeredAt: string | null; openedAt: string | null; dismissedAt: string | null;
  /** The moment the row shows. */
  at: string;
  unread: boolean;
  stepsTotal: number; stepsDone: number;
  /** The thread's proposal: folded into this row while pending. */
  proposal: { id: string; status: string; priority: string } | null;
  followUps: number;
}

export interface ProposalCardDTO {
  id: string; status: string; kind: string; priority: string;
  /** "Antwoord aan Bewindkantoor Noordkust". */
  title: string | null;
  to: string[]; subject: string | null; attachmentCount: number; sentAt: string | null;
}

export interface RequestDTO {
  id: string; rootId: string; clientId: string; text: string; status: string;
  title: string;
  /** The outcome in one line: the answer screen's title. */
  headline: string | null;
  phase: string | null; todoReason: string | null; doneReason: string | null;
  parentRequestId: string | null;
  createdAt: string; claimedAt: string | null; answeredAt: string | null; openedAt: string | null;
  dismissedAt: string | null; updatedAt: string;
  unread: boolean;
  /** While working: "leest 4 documenten, zoekt in Gmail". */
  progressLine: string | null;
  /** When failed: "Lukte niet" or "Duurde te lang". */
  failure: string | null;
  /** When failed: "Wat er gebeurde", one Dutch paragraph. */
  failureDetail: string | null;
  about: { type: string; id: string; label: string; meta: string[]; at: string | null } | null;
  answer: string | null;
  /** Each opens its item; a Gmail message is shown as the tool read it. */
  sources: RequestSourceDetail[];
  martinSteps: string[];
  /** "Wat jij nog moet doen", with Martin's ticks. */
  steps: { index: number; text: string; doneAt: string | null }[];
  /** The proposal card; it opens the EXISTING proposal screen by `id`. */
  proposal: ProposalCardDTO | null;
  /** The card's proposal is being rewritten by this (working) follow-up. */
  proposalUpdating: boolean;
  /** Live while queued or working (and the log of a failure), from the tool log. */
  progress: { calls: number; documents: number; mails: number; liveMail: number; line: string | null;
    steps: { label: string; state: string }[] } | null;
  /** "Vraag door": the earlier questions in this thread, oldest first. */
  thread: { id: string; text: string; status: string; createdAt: string; title: string; headline: string | null;
    answer: string | null; proposal: ProposalCardDTO | null }[];
  followUps: { id: string; text: string; status: string; createdAt: string }[];
}

export function toRequestListItemDTO(r: RequestListSource): RequestListItemDTO {
  return {
    id: r.id, rootId: r.rootId, text: r.text, title: r.title, status: r.status,
    phase: r.phase, todoReason: r.todoReason, doneReason: r.doneReason, meta: r.meta,
    parentRequestId: r.parentRequestId,
    createdAt: iso(r.createdAt)!, answeredAt: iso(r.answeredAt), openedAt: iso(r.openedAt),
    dismissedAt: iso(r.dismissedAt), at: iso(r.at)!,
    unread: r.unread, stepsTotal: r.stepsTotal, stepsDone: r.stepsDone,
    proposal: r.proposal ? { id: r.proposal.id, status: r.proposal.status, priority: r.proposal.priority } : null,
    followUps: r.followUps,
  };
}

const card = (p: ProposalCardSource | null): ProposalCardDTO | null => p ? {
  id: p.id, status: p.status, kind: p.kind, priority: p.priority, title: p.title,
  to: p.to, subject: p.subject, attachmentCount: p.attachmentCount, sentAt: iso(p.sentAt),
} : null;

export function toRequestDTO(r: RequestDetailSource): RequestDTO {
  return {
    id: r.id, rootId: r.rootId, clientId: r.clientId, text: r.text, status: r.status,
    title: r.title, headline: r.headline,
    phase: r.phase, todoReason: r.todoReason, doneReason: r.doneReason,
    parentRequestId: r.parentRequestId,
    createdAt: iso(r.createdAt)!, claimedAt: iso(r.claimedAt), answeredAt: iso(r.answeredAt),
    openedAt: iso(r.openedAt), dismissedAt: iso(r.dismissedAt), updatedAt: iso(r.updatedAt)!,
    unread: r.unread, progressLine: r.progressLine, failure: r.failure, failureDetail: r.failureDetail,
    about: r.about,
    answer: r.answer,
    sources: r.sources.map((s) => ({ ...s })),
    martinSteps: r.martinSteps,
    steps: r.steps,
    proposal: card(r.proposal),
    proposalUpdating: r.proposalUpdating,
    progress: r.progress ? { calls: r.progress.calls, documents: r.progress.documents, mails: r.progress.mails,
      liveMail: r.progress.gmail, line: r.progress.line, steps: r.progress.steps } : null,
    thread: r.thread.map((t) => ({ id: t.id, text: t.text, status: t.status, createdAt: iso(t.createdAt)!,
      title: t.title, headline: t.headline, answer: t.answer, proposal: card(t.proposal) })),
    followUps: r.followUps.map((f) => ({ id: f.id, text: f.text, status: f.status, createdAt: iso(f.createdAt)! })),
  };
}
