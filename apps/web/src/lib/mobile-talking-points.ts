import type { PartyTalkingPoints } from "@grip/api/src/talking-points-load";

/**
 * The phone's talking points, HAND-SHAPED: every field is named here, so a
 * column added to a router later never reaches the phone by accident.
 *
 * `summary` is the one AI line. It is non-null ONLY when the host drafter's
 * answer passed the store step (party_briefs.status = 'ready'), and it always
 * carries `ai: true` and its Dutch label, so the screen can never present it as
 * a dossier fact. Its `sourceRefs` name the mails, tasks and debts it was
 * written from — ids only; the raw-email row id is a dossier id, never a Gmail
 * id or an address.
 */
export interface TalkingPointDTO {
  id: string;
  text: string;
  source: { type: "task" | "proposal" | "debt" | "mail" | "document" | "stop"; id: string; link: string };
}

export interface TalkingPointsDTO {
  /** `phone`: the number the call sheet's "Bel" dials (a `tel:` link), or null. */
  party: { id: string; name: string; phone: string | null };
  tell: TalkingPointDTO[];
  ask: TalkingPointDTO[];
  summary: null | {
    text: string; model: string | null; promptVersion: string | null; generatedAt: string;
    sourceRefs: { type: "mail" | "task" | "debt"; id: string }[];
    ai: true; label: string;
  };
}

const pointDTO = (p: PartyTalkingPoints["tell"][number]): TalkingPointDTO => ({
  id: p.id, text: p.text, source: { type: p.source.type, id: p.source.id, link: p.source.link },
});

export function toTalkingPointsDTO(r: PartyTalkingPoints): TalkingPointsDTO {
  const s = r.summary;
  return {
    party: { id: r.party.id, name: r.party.name, phone: r.party.phone ?? null },
    tell: r.tell.map(pointDTO),
    ask: r.ask.map(pointDTO),
    summary: s ? {
      text: s.text, model: s.model, promptVersion: s.promptVersion, generatedAt: s.generatedAt,
      sourceRefs: s.sourceRefs.map((x) => ({ type: x.type, id: x.id })), ai: true, label: s.label,
    } : null,
  };
}
