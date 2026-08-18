import { serverCaller } from "@/lib/trpc-server";
import { SuggestionCard } from "@/components/suggestion-card";

export default async function QueuePage() {
  const caller = await serverCaller();
  const pending = await caller.suggestions.list({ status: "pending" });
  const manual = await caller.suggestions.list({ status: "needs-manual" });
  const all = [...pending, ...manual];
  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">Review queue</h1>
      <p className="text-slate-600 mb-6">{all.length
        ? `${all.length} suggestion${all.length > 1 ? "s" : ""} waiting — you decide what becomes part of the record.`
        : "Queue is empty. Everything's handled — take a breather. ☕"}</p>
      <ul className="space-y-4 max-w-2xl">{all.map((s) => <SuggestionCard key={s.id} s={s} />)}</ul>
    </div>
  );
}
