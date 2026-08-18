import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readFilePath, storeFile } from "./storage";

describe("content-addressed storage", () => {
  it("stores by sha256 with fan-out dirs and is idempotent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vault-"));
    const buf = Buffer.from("hello evidence");
    const a = await storeFile(dir, buf);
    const b = await storeFile(dir, buf);
    expect(a.sha256).toBe(b.sha256);
    expect(a.relPath).toBe(`${a.sha256.slice(0, 2)}/${a.sha256.slice(2, 4)}/${a.sha256}`);
    const back = await readFile(readFilePath(dir, a.sha256));
    expect(back.equals(buf)).toBe(true);
  });
});
