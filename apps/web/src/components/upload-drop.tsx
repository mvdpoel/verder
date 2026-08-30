"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { cx } from "@/components/ui";

export function UploadDrop() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  // Purely visual: a drop target that does not answer a file held over it gives
  // no sign it will accept one, and the cursor is the only other clue.
  const [over, setOver] = useState(false);
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
    <label
      className={cx(
        "flex cursor-pointer flex-col items-center justify-center gap-[14px] rounded-panel",
        "border border-dashed p-[34px] text-center transition-colors",
        // `has-[:focus-visible]` puts the keyboard's ring on the frame: the file
        // input itself is visually hidden, so without this the target lights up
        // for a mouse and stays invisible to a keyboard.
        "has-[:focus-visible]:border-signal",
        over && "border-signal bg-signal/5",
        busy && "pointer-events-none border-signal/45",
        !over && !busy && "border-edge-strong hover:border-signal/50",
      )}
      onDragEnter={(e) => { e.preventDefault(); setOver(true); }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); void upload(e.dataTransfer.files); }}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
        className={cx("transition-colors", over || busy ? "text-signal" : "text-ink-faint")}>
        <path d="M12 16V4M7.5 8.5 12 4l4.5 4.5" />
        <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
      </svg>
      <span className={cx(
        "text-[13.5px] font-light",
        busy ? "animate-breathe text-signal" : over ? "text-ink-bright" : "text-ink-mute",
      )}>
        {busy ? "Veilig aan het opbergen…" : "Sleep bestanden hierheen, of klik om ze aan je kluis toe te voegen"}
      </span>
      {/* `sr-only` and not `hidden`: a display:none input cannot be reached by
          tab, which took the whole upload away from the keyboard. */}
      <input type="file" multiple className="sr-only" onChange={(e) => void upload(e.target.files)} />
    </label>
  );
}
