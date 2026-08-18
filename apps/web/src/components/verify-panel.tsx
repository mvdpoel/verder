"use client";
import { useState } from "react";
import { trpc } from "@/lib/trpc-client";

export function VerifyPanel() {
  const run = trpc.verify.run.useMutation();
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  return (
    <div className="max-w-xl space-y-6">
      <div className="rounded border bg-white p-6 space-y-3">
        <h2 className="font-semibold">Integrity check</h2>
        <p className="text-sm text-slate-600">Recomputes every hash in the chain and re-reads every stored file.</p>
        <button className="rounded bg-slate-900 text-white px-4 py-2" disabled={run.isPending}
          onClick={() => run.mutate()}>{run.isPending ? "Checking…" : "Run verification"}</button>
        {run.data && (run.data.ok
          ? <p className="text-emerald-700">✔ All good. {run.data.count} events verified, {run.data.checkedFiles} files re-hashed.<br />
              <span className="text-xs break-all">Chain head: {run.data.headHash}</span></p>
          : <p className="text-red-700">✘ Chain broken at event {run.data.brokenAtSeq} ({run.data.reason}). Don't panic — nothing is lost; investigate before writing anything new.</p>)}
      </div>
      <div className="rounded border bg-white p-6 space-y-3">
        <h2 className="font-semibold">Export a report</h2>
        <div className="flex gap-2">
          <input type="date" className="border rounded p-2" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input type="date" className="border rounded p-2" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <a className={`inline-block rounded border px-4 py-2 ${!from || !to ? "pointer-events-none opacity-50" : ""}`}
          href={`/verify/export?from=${from}&to=${to}`} target="_blank">Open report (print → PDF)</a>
      </div>
    </div>
  );
}
