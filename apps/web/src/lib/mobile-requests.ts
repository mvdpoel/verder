/**
 * Vraag Grip on the phone: the JSON the request routes serve
 * (spec docs/superpowers/specs/2026-11-04-vraag-grip-design.md, "Phone").
 *
 * The router (`packages/api/src/routers/requests.ts`) decides what a request
 * shows; this file only fixes the wire shape — every instant an ISO string,
 * every absent value `null` — so the fixtures the simulator draws
 * (`mobile-requests.fixture.test.ts`) are this DTO over synthetic rows and
 * cannot drift from what the route serves. The sources are structural copies
 * of the router's output, as `mobile-dto.ts` does for its own.
 */

type When = Date | string | null;
const iso = (d: When): string | null => (d == null ? null : new Date(d).toISOString());

export interface RequestListSource {
  id: string; clientId: string; text: string; status: string; parentRequestId: string | null;
  createdAt: Date | string; claimedAt: When; answeredAt: When; openedAt: When;
  unread: boolean; progressLine: string | null; failure: string | null;
  proposal: { id: string; status: string } | null;
}

export interface RequestDetailSource extends Omit<RequestListSource, "proposal"> {
  about: { type: string; id: string; label: string } | null;
  answer: string | null;
  sources: { type: string; id: string; why: string; label?: string }[];
  martinSteps: string[];
  proposal: { id: string; status: string; kind: string; to: string[]; subject: string | null; attachmentCount: number } | null;
  progress: { calls: number; documents: number; mails: number; gmail: number; line: string | null } | null;
  thread: { id: string; text: string; status: string; createdAt: Date | string; answer: string | null }[];
  followUps: { id: string; text: string; status: string; createdAt: Date | string }[];
}

export interface RequestListItemDTO {
  id: string; clientId: string; text: string;
  /** queued · working · answered · failed (cancelled requests are not listed). */
  status: string;
  parentRequestId: string | null;
  createdAt: string; claimedAt: string | null; answeredAt: string | null; openedAt: string | null;
  /** Answered and not yet opened: counts as waiting on Martin. */
  unread: boolean;
  /** While working: "leest 4 documenten, zoekt in Gmail". */
  progressLine: string | null;
  /** When failed: "Lukte niet" or "Duurde te lang". */
  failure: string | null;
  proposal: { id: string; status: string } | null;
}

export interface RequestDTO extends Omit<RequestListItemDTO, "proposal"> {
  about: { type: string; id: string; label: string } | null;
  answer: string | null;
  /** Each opens its item: document, mail, gmail, transaction, party, debt, stop, task, entry. */
  sources: { type: string; id: string; why: string; label: string | null }[];
  martinSteps: string[];
  /** The proposal card; it opens the EXISTING proposal screen by `id`. */
  proposal: { id: string; status: string; kind: string; to: string[]; subject: string | null; attachmentCount: number } | null;
  /** Live while queued or working, from the tool log; null otherwise. */
  progress: { calls: number; documents: number; mails: number; liveMail: number; line: string | null } | null;
  /** "Vraag door": the earlier questions in this thread, oldest first. */
  thread: { id: string; text: string; status: string; createdAt: string; answer: string | null }[];
  followUps: { id: string; text: string; status: string; createdAt: string }[];
}

export function toRequestListItemDTO(r: RequestListSource): RequestListItemDTO {
  return {
    id: r.id, clientId: r.clientId, text: r.text, status: r.status, parentRequestId: r.parentRequestId,
    createdAt: iso(r.createdAt)!, claimedAt: iso(r.claimedAt), answeredAt: iso(r.answeredAt), openedAt: iso(r.openedAt),
    unread: r.unread, progressLine: r.progressLine, failure: r.failure,
    proposal: r.proposal ? { id: r.proposal.id, status: r.proposal.status } : null,
  };
}

export function toRequestDTO(r: RequestDetailSource): RequestDTO {
  return {
    ...toRequestListItemDTO({ ...r, proposal: r.proposal }),
    about: r.about,
    answer: r.answer,
    sources: r.sources.map((s) => ({ type: s.type, id: s.id, why: s.why, label: s.label ?? null })),
    martinSteps: r.martinSteps,
    proposal: r.proposal,
    progress: r.progress ? { calls: r.progress.calls, documents: r.progress.documents, mails: r.progress.mails,
      liveMail: r.progress.gmail, line: r.progress.line } : null,
    thread: r.thread.map((t) => ({ id: t.id, text: t.text, status: t.status, createdAt: iso(t.createdAt)!, answer: t.answer })),
    followUps: r.followUps.map((f) => ({ id: f.id, text: f.text, status: f.status, createdAt: iso(f.createdAt)! })),
  };
}
