"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import type { DebtPartyRole } from "./registry-list";
import {
  Button,
  Chip,
  Field,
  Input,
  Label,
  Micro,
  Panel,
  Select,
  TextLink,
  type ChipTone,
} from "@/components/ui";

// Editable edges for a debt: who is chasing it, what paperwork proves it, and
// whether Verder has been told. None of this is evidence (debts/debt_parties/
// debt_documents are display facts, not the ledger) so link/unlink/reported
// are plain mutations, same mutation-plus-router.refresh() pattern as
// item-facts-form.tsx. It reports, it does not judge: an unreported debt
// reads as a neutral fact, never a warning — which is why nothing in here is
// amber, not even "Not reported to Verder yet".

const ROLES: DebtPartyRole[] = ["eiser", "incasso", "deurwaarder", "gemachtigde"];

/**
 * The claimant is the party that actually owns the claim; the rest are acting
 * for someone. Giving the eiser the stronger chip is the whole reason a debt
 * gained a party TABLE — "Trust and Law collecting for PLM Investments" used
 * to be prose in a note.
 */
const ROLE_TONE = (role: DebtPartyRole): ChipTone => (role === "eiser" ? "mute" : "faint");

/** The small × that removes a link. Icon-only, so it carries its own label. */
function RemoveButton({ label, disabled, onClick }: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="shrink-0 rounded-chip px-[6px] font-mono text-[13px] leading-none text-ink-dim transition-colors hover:text-attn disabled:opacity-40 disabled:pointer-events-none"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      ×
    </button>
  );
}

export type DebtPartyLink = {
  partyId: string;
  name: string;
  organization: string | null;
  role: DebtPartyRole;
  note: string | null;
};

export type DebtDocumentLink = { id: string; title: string; mime: string };

export function DebtPartiesForm({ debtId, parties, debtDocuments, reportedToVerderAt, reportedViaEntryId }: {
  debtId: string;
  parties: DebtPartyLink[];
  debtDocuments: DebtDocumentLink[];
  reportedToVerderAt: Date | null;
  reportedViaEntryId: string | null;
}) {
  const router = useRouter();
  const refresh = () => router.refresh();

  const allParties = trpc.parties.list.useQuery();
  const allDocuments = trpc.documents.list.useQuery({ limit: 100 });
  const entries = trpc.entries.list.useQuery({ limit: 100 });

  const linkParty = trpc.registry.debts.linkParty.useMutation({ onSuccess: refresh });
  const unlinkParty = trpc.registry.debts.unlinkParty.useMutation({ onSuccess: refresh });
  const linkDocument = trpc.registry.debts.linkDocument.useMutation({ onSuccess: refresh });
  const unlinkDocument = trpc.registry.debts.unlinkDocument.useMutation({ onSuccess: refresh });
  const setReported = trpc.registry.debts.setReported.useMutation({ onSuccess: refresh });

  const [newPartyId, setNewPartyId] = useState("");
  const [newRole, setNewRole] = useState<DebtPartyRole>("eiser");
  const [newNote, setNewNote] = useState("");
  const [newDocId, setNewDocId] = useState("");
  const [reportEntryId, setReportEntryId] = useState(reportedViaEntryId ?? "");

  const linkedDocIds = new Set(debtDocuments.map((d) => d.id));
  const availableDocuments = (allDocuments.data ?? []).filter((d) => !linkedDocIds.has(d.id));

  const addParty = () => {
    if (!newPartyId) return;
    linkParty.mutate({ debtId, partyId: newPartyId, role: newRole, note: newNote || undefined });
    setNewPartyId("");
    setNewNote("");
  };

  const addDocument = () => {
    if (!newDocId) return;
    linkDocument.mutate({ debtId, documentId: newDocId });
    setNewDocId("");
  };

  const markReported = () => {
    setReported.mutate({ debtId, reportedAt: new Date(), entryId: reportEntryId || null });
  };

  const clearReported = () => {
    setReported.mutate({ debtId, reportedAt: null });
    setReportEntryId("");
  };

  return (
    <>
      <Panel as="section" className="flex flex-col gap-[18px] p-[26px]">
        <Label as="h2">Parties</Label>
        {parties.length === 0
          ? <p className="text-[13px] font-light text-ink-label">No parties linked yet.</p>
          : (
            <ul>
              {parties.map((p) => (
                <li
                  key={`${p.partyId}-${p.role}`}
                  className="flex items-center gap-3 border-b border-hairline py-[11px] last:border-0">
                  <Chip tone={ROLE_TONE(p.role)}>{p.role}</Chip>
                  <span className="min-w-0 grow text-[13.5px] font-light text-ink-soft">
                    {p.name}
                    {p.organization && <span className="text-ink-mute"> ({p.organization})</span>}
                    {p.note && <span className="text-ink-mute"> — {p.note}</span>}
                  </span>
                  <RemoveButton
                    label={`Remove ${p.name} as ${p.role}`}
                    disabled={unlinkParty.isPending}
                    onClick={() => unlinkParty.mutate({ debtId, partyId: p.partyId, role: p.role })}
                  />
                </li>
              ))}
            </ul>
          )}
        <div className="flex flex-wrap items-end gap-[14px]">
          <Field label="Party" htmlFor="parties-party" className="min-w-[180px] grow">
            <Select id="parties-party" value={newPartyId}
              onChange={(e) => setNewPartyId(e.target.value)}>
              <option value="">Choose…</option>
              {allParties.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label="Role" htmlFor="parties-role" className="min-w-[130px]">
            <Select id="parties-role" value={newRole}
              onChange={(e) => setNewRole(e.target.value as DebtPartyRole)}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </Select>
          </Field>
          <Field label="Note" htmlFor="parties-note" className="min-w-[160px] grow">
            <Input id="parties-note" placeholder="optional"
              value={newNote} onChange={(e) => setNewNote(e.target.value)} />
          </Field>
          <Button variant="ghost" size="sm" className="mb-[1px]"
            disabled={!newPartyId || linkParty.isPending} onClick={addParty}>
            Add
          </Button>
        </div>
      </Panel>

      <Panel as="section" className="flex flex-col gap-[18px] p-[26px]">
        <Label as="h2">Paperwork</Label>
        {debtDocuments.length === 0
          ? <p className="text-[13px] font-light text-ink-label">No documents filed against this debt yet.</p>
          : (
            <ul>
              {debtDocuments.map((d) => (
                <li key={d.id} className="flex items-center gap-3 border-b border-hairline py-[11px] last:border-0">
                  <TextLink
                    href={`/vault/${d.id}`}
                    className="min-w-0 grow truncate text-[13.5px] font-light">
                    {d.title}
                  </TextLink>
                  <RemoveButton
                    label={`Unlink ${d.title}`}
                    disabled={unlinkDocument.isPending}
                    onClick={() => unlinkDocument.mutate({ debtId, documentId: d.id })}
                  />
                </li>
              ))}
            </ul>
          )}
        <div className="flex flex-wrap items-end gap-[14px]">
          <Field label="Document" htmlFor="parties-document" className="min-w-[200px] grow">
            <Select id="parties-document" value={newDocId}
              onChange={(e) => setNewDocId(e.target.value)}>
              <option value="">Choose…</option>
              {availableDocuments.map((d) => <option key={d.id} value={d.id}>{d.effectiveTitle}</option>)}
            </Select>
          </Field>
          <Button variant="ghost" size="sm" className="mb-[1px]"
            disabled={!newDocId || linkDocument.isPending} onClick={addDocument}>
            Link
          </Button>
        </div>
      </Panel>

      <Panel as="section" className="flex flex-col gap-[18px] p-[26px]">
        <Label as="h2">Verder</Label>
        {/* Calm, not alarmed: an unreported debt is a fact to record, not a
            warning — Martin is the person this is about. */}
        {reportedToVerderAt
          ? (
            <Micro>
              Reported to Verder on {new Date(reportedToVerderAt).toLocaleDateString("nl-NL")}
              {reportedViaEntryId && (
                <> · <TextLink href={`/logbook/${reportedViaEntryId}`}>see the entry</TextLink></>
              )}
            </Micro>
          )
          : <Micro>Not reported to Verder yet.</Micro>}
        <div className="flex flex-wrap items-end gap-[14px]">
          <Field label="Via entry (optional)" htmlFor="parties-entry" className="min-w-[240px] grow">
            <Select id="parties-entry" value={reportEntryId}
              onChange={(e) => setReportEntryId(e.target.value)}>
              <option value="">No specific entry</option>
              {entries.data?.map((e) => (
                <option key={e.id} value={e.id}>
                  {new Date(e.occurredAt).toLocaleDateString("nl-NL")} — {e.summary}
                </option>
              ))}
            </Select>
          </Field>
          <Button variant="ghost" size="sm" className="mb-[1px]"
            disabled={setReported.isPending} onClick={markReported}>
            {reportedToVerderAt ? "Update reported date" : "Mark reported today"}
          </Button>
          {reportedToVerderAt && (
            <Button variant="quiet" size="sm" className="mb-[1px]"
              disabled={setReported.isPending} onClick={clearReported}>
              Clear
            </Button>
          )}
        </div>
      </Panel>
    </>
  );
}
