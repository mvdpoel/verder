import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256Hex } from "@verder/core";

export function relPathFor(sha256: string): string {
  return join(sha256.slice(0, 2), sha256.slice(2, 4), sha256);
}

export function readFilePath(vaultDir: string, sha256: string): string {
  return join(vaultDir, relPathFor(sha256));
}

export async function storeFile(vaultDir: string, buf: Buffer): Promise<{ sha256: string; relPath: string }> {
  const sha256 = sha256Hex(buf);
  const relPath = relPathFor(sha256);
  const abs = join(vaultDir, relPath);
  try {
    await access(abs);
  } catch {
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, buf, { flag: "wx" }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "EEXIST") throw e;
    });
  }
  return { sha256, relPath };
}
