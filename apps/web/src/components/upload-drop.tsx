"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function UploadDrop() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    for (const file of Array.from(files)) {
      const fd = new FormData(); fd.append("file", file);
      await fetch("/api/upload", { method: "POST", body: fd });
    }
    setBusy(false); router.refresh();
  };
  return (
    <label className="block rounded border-2 border-dashed p-8 text-center cursor-pointer bg-white"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); void upload(e.dataTransfer.files); }}>
      {busy ? "Storing safely…" : "Drop files here or click to add them to your vault"}
      <input type="file" multiple className="hidden" onChange={(e) => void upload(e.target.files)} />
    </label>
  );
}
