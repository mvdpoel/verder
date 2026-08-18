import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { TRPCError } from "@trpc/server";
import { readFilePath } from "@verder/api/src/storage";
import { serverCaller } from "@/lib/trpc-server";

export async function GET(_req: Request, { params }: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await params;
  try {
    const caller = await serverCaller(); // protectedProcedure rejects unauthenticated calls
    const doc = await caller.documents.bySha({ sha256 });
    const buf = await readFile(readFilePath(process.env.VAULT_DIR ?? "./vault-files", sha256));
    return new NextResponse(new Uint8Array(buf), { headers: { "Content-Type": doc.mime } });
  } catch (e) {
    if (e instanceof TRPCError) {
      if (e.code === "UNAUTHORIZED") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      if (e.code === "NOT_FOUND" || e.code === "BAD_REQUEST")
        return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    throw e;
  }
}
