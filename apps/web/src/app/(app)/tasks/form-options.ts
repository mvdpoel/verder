import { serverCaller } from "@/lib/trpc-server";
import type { TaskFormOptions } from "@/components/task-form";

/** Select options for the task form's assignee + optional evidence links. */
export async function taskFormOptions(): Promise<TaskFormOptions> {
  const caller = await serverCaller();
  const [parties, entries, items, debts, documents] = await Promise.all([
    caller.parties.list(),
    caller.entries.list({ limit: 100 }),
    caller.registry.items.list(),
    caller.registry.debts.list(),
    caller.documents.list({ limit: 100 }),
  ]);
  return {
    parties: parties.map((p) => ({ id: p.id, name: p.name })),
    entries: entries.map((e) => ({
      id: e.id,
      label: `${new Date(e.occurredAt).toLocaleDateString("nl-NL")} — ${
        e.summary.length > 60 ? `${e.summary.slice(0, 60)}…` : e.summary}`,
    })),
    items: items.map((i) => ({ id: i.id, name: i.name })),
    debts: debts.map((d) => ({ id: d.id, creditorName: d.creditorName })),
    documents: documents.map((d) => ({ id: d.id, title: d.effectiveTitle })),
  };
}
