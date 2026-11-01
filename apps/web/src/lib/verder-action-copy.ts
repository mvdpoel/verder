import type { VerderActionDTO } from "@verder/api/src/routers/verder-actions";

/**
 * The words "Door verder gedaan" uses for one action, on the web. Pure, so the
 * copy is tested without React. The phone spells the same sentences in
 * DoneByVerderSection.swift; keep the two in step.
 */

const STATUS: Record<string, string> = { inbox: "inbox", filed: "opgeborgen", discarded: "weggegooid" };
const status = (s: string) => STATUS[s] ?? s;
const soort = (t: string | null) => (t && t.trim() ? t.trim() : "zonder soort");

/** What changed, before → after, one clause per field that moved. */
export function verderActionChanges(a: Pick<VerderActionDTO, "before" | "after">): string[] {
  const out: string[] = [];
  if (a.before.status !== a.after.status)
    out.push(`${status(a.before.status)} → ${status(a.after.status)}`);
  if (soort(a.before.docType) !== soort(a.after.docType))
    out.push(`soort ${soort(a.before.docType)} → ${soort(a.after.docType)}`);
  if (a.before.title !== a.after.title)
    out.push(`naam ${a.before.title ?? "—"} → ${a.after.title ?? "—"}`);
  return out;
}

export function verderActionHeadline(a: Pick<VerderActionDTO, "kind">): string {
  return a.kind === "auto-file" ? "Opgeborgen door verder" : "Hernoemd door verder";
}

/**
 * Why the button is off. An auto-name is reversed on the host with
 * `normalize-names --undo`, because the name also lives on the NAS share.
 */
export function verderActionNote(a: Pick<VerderActionDTO, "undone" | "notUndoableReason">): string | null {
  if (a.undone) return "Ongedaan gemaakt";
  switch (a.notUndoableReason) {
    case "al aangepast": return "Al aangepast — niet meer terug te draaien";
    case "vernietigd": return "Vernietigd";
    case "naam staat ook op de NAS": return "De naam staat ook op de NAS; terugdraaien gaat via normalize-names --undo";
    default: return null;
  }
}
