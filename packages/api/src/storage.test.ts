import { mkdtempSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { readFilePath, relPathFor, storeFile } from "./storage";

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

  it("rejects a sha256 that is not 64 lowercase hex chars", () => {
    const traversal = "../".repeat(18) + "etc/passwd"; // 64 chars
    expect(() => relPathFor(traversal)).toThrow();
    expect(() => readFilePath("/vault", traversal)).toThrow();
    expect(() => relPathFor("A".repeat(64))).toThrow();
    expect(() => relPathFor("a".repeat(63))).toThrow();
  });

  it("heals a corrupt partial file left at the final path by a crashed write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vault-"));
    const buf = Buffer.from("hello evidence");
    const { sha256, relPath } = await storeFile(mkdtempSync(join(tmpdir(), "vault-")), buf);
    // simulate a crash mid-write: truncated bytes already sit at the final path
    const abs = join(dir, relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, buf.subarray(0, 5));
    const res = await storeFile(dir, buf);
    expect(res.sha256).toBe(sha256);
    const back = await readFile(abs);
    expect(back.equals(buf)).toBe(true); // corrupt bytes must not be trusted
  });

  it("leaves no temp files behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vault-"));
    const buf = Buffer.from("hello evidence");
    const { sha256, relPath } = await storeFile(dir, buf);
    await storeFile(dir, buf); // second write of same content
    const files = await readdir(join(dir, dirname(relPath)));
    expect(files).toEqual([sha256]);
  });
});
