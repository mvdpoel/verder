import { serverCaller } from "@/lib/trpc-server";
import { VerifyPanel } from "@/components/verify-panel";
import { IndexHealthCard } from "@/components/index-health";
import { PageTitle } from "@/components/ui";

export default async function VerifyPage() {
  const caller = await serverCaller();
  const health = await caller.search.health();
  return (
    <div className="flex flex-col gap-8">
      <PageTitle>Controle & export</PageTitle>
      {/*
        Two columns, and the wider one on the left is the evidence: the chain
        check and the report drawn from it. The search index sits BESIDE it
        rather than above it because it is derived and rebuildable — putting it
        first, as this page used to, made the cheap check look like the point.
      */}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] xl:items-start">
        <VerifyPanel />
        <IndexHealthCard health={health} now={Date.now()} />
      </div>
    </div>
  );
}
