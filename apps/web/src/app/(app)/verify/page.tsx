import { serverCaller } from "@/lib/trpc-server";
import { VerifyPanel } from "@/components/verify-panel";
import { IndexHealthCard } from "@/components/index-health";

export default async function VerifyPage() {
  const caller = await serverCaller();
  const health = await caller.search.health();
  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Verify & export</h1>
      <div className="max-w-xl mb-6">
        <IndexHealthCard health={health} now={Date.now()} />
      </div>
      <VerifyPanel />
    </div>
  );
}
