import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { sha256Hex } from "@verder/core";

const SHA256_RE = /^[0-9a-f]{64}$/;

function assertSha256(sha256: string): void {
  if (!SHA256_RE.test(sha256)) {
    throw new Error("Invalid sha256: expected 64 lowercase hex characters");
  }
}

export function relPathFor(sha256: string): string {
  assertSha256(sha256);
  return join(sha256.slice(0, 2), sha256.slice(2, 4), sha256);
}

export function readFilePath(vaultDir: string, sha256: string): string {
  return join(vaultDir, relPathFor(sha256));
}

export async function storeFile(vaultDir: string, buf: Buffer): Promise<{ sha256: string; relPath: string }> {
  const sha256 = sha256Hex(buf);
  const relPath = relPathFor(sha256);
  const abs = join(vaultDir, relPath);
  // Crash-safe write: stage in a temp file in the same directory, then
  // atomically rename onto the final content-addressed path. A crash mid-write
  // can only leave a stray temp file, never a partial file at the final path;
  // rename also makes concurrent writers of the same content safe, and heals
  // any corrupt partial file a pre-fix crash left behind.
  await mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(tmp, buf, { flag: "wx" });
    await rename(tmp, abs);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
  return { sha256, relPath };
}
