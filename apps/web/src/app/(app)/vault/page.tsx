import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";
import { UploadDrop } from "@/components/upload-drop";

export default async function VaultPage() {
  const caller = await serverCaller();
  const inbox = await caller.documents.list({ status: "inbox", limit: 100 });
  const filed = await caller.documents.list({ status: "filed", limit: 100 });
  const Row = ({ d }: { d: (typeof inbox)[number] }) => (
    <li className="rounded border bg-white p-3 flex justify-between">
      <Link href={`/vault/${d.id}`} className="hover:underline">{d.effectiveTitle}</Link>
      <span className="text-xs text-slate-500">{d.effectiveDocType ?? d.mime} · {(d.sizeBytes / 1024).toFixed(0)} KB · {d.source}</span>
    </li>
  );
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Vault</h1>
      <UploadDrop />
      <section>
        <h2 className="font-semibold mb-2">Inbox — {inbox.length ? `${inbox.length} to sort, no rush` : "all sorted, nice work ✨"}</h2>
        <ul className="space-y-2">{inbox.map((d) => <Row key={d.id} d={d} />)}</ul>
      </section>
      <section>
        <h2 className="font-semibold mb-2">Filed documents</h2>
        <ul className="space-y-2">{filed.map((d) => <Row key={d.id} d={d} />)}</ul>
      </section>
    </div>
  );
}
