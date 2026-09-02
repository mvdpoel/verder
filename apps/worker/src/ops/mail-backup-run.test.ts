import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { BACKUP_WORKER, parseOutcome } from "./mail-backup-run";
import { MAIL_BACKUP_WORKER_NAME } from "@verder/api/src/worker-names";

// NO DATABASE IN THIS FILE, deliberately — the same rule mail-restore-drill.test
// keeps. parseOutcome is pure, and the whole contract worth pinning is what
// reaches `recordRun`: a status that is exactly ok or error, a detail that
// cannot carry anything but digits, and a worker name the caller has no way to
// touch. A row actually landing in postgres is what the nightly run proves.

describe("parseOutcome — the status", () => {
  it("takes ok and error and nothing else", () => {
    expect(parseOutcome(["ok"]).status).toBe("ok");
    expect(parseOutcome(["error"]).status).toBe("error");
  });

  /*
   * THE REFUSAL IS THE POINT, not politeness. workerState treats every string
   * that is not exactly "ok" as a failure, so a caller that fumbled its argument
   * would paint the tile amber with no way to tell that from a backup that
   * actually broke — and a caller that fumbled it the other way ("OK") would
   * report a failed night as healthy. Throwing writes no row at all, which the
   * shell surfaces as "could not record the row" in the cron log: loud, and
   * honest about which of the two things went wrong.
   */
  it("refuses a status that is not exactly one of the two", () => {
    for (const bad of ["OK", "Ok", "ERROR", "success", "fail", "0", "1", "true", "okay"]) {
      expect(() => parseOutcome([bad])).toThrow(/expected ok or error/);
    }
  });

  it("refuses a missing or empty status rather than defaulting to one", () => {
    // Defaulting either way is a lie: to "ok" it hides a broken night, to
    // "error" it invents one. `mail-backup-run` with no argument is a caller
    // bug, and the usage line says so.
    expect(() => parseOutcome([])).toThrow(/usage/);
    expect(() => parseOutcome([""])).toThrow(/usage/);
    expect(() => parseOutcome(["   "])).toThrow(/usage/);
  });

  it("absorbs a shell's trailing whitespace but compares exactly", () => {
    expect(parseOutcome(["ok\n"]).status).toBe("ok");
    expect(parseOutcome([" error "]).status).toBe("error");
    // The trim is not a licence to be case-insensitive.
    expect(() => parseOutcome([" Ok "])).toThrow(/expected ok or error/);
  });

  it("quotes the refused value in the message without pasting a whole shell line", () => {
    // The message reaches a cron log that is kept, and argv is whatever the
    // shell handed over. Capped, so a runaway argument cannot become the log.
    const huge = "x".repeat(5_000);
    expect(() => parseOutcome([huge])).toThrow(/refusing to record status "x{40}" —/);
  });
});

describe("parseOutcome — the detail", () => {
  it("carries the failing line and exit status on the error path", () => {
    expect(parseOutcome(["error", "217", "2"]).detail).toEqual({ failedLine: 217, exitStatus: 2 });
  });

  it("offers no detail rather than an empty one when nothing was passed", () => {
    // recordRun stores `null` for undefined. `{}` on the dashboard reads as
    // detail that went missing rather than detail that was never offered.
    expect(parseOutcome(["ok"]).detail).toBeUndefined();
    expect(parseOutcome(["error"]).detail).toBeUndefined();
  });

  /*
   * NUMBERS ONLY, AND IT IS A SECRET-SAFETY GUARANTEE BY CONSTRUCTION.
   * `worker_runs.detail` is rendered on the dashboard and dumped off-box by the
   * nightly pg_dump, and mail-backup.sh is the one script that handles the JMAP
   * app password (`-e VANDELAY_PASSWORD`, name-only, for exactly this reason).
   * A free-text note — $BASH_COMMAND, an error line, anything expanded from the
   * environment — is one careless interpolation away from archiving that
   * password on the NAS for a year. This parser makes that impossible rather
   * than unlikely.
   */
  it("cannot be made to carry text of any kind", () => {
    const attempts = [
      "tar -cf - etc data blobs",
      "VANDELAY_PASSWORD=hunter2",
      "217; rm -rf /",
      "0x10", "1e3", "Infinity", "NaN", "-1", "1.5", "٤٢", "12abc", "",
    ];
    for (const a of attempts) {
      const out = parseOutcome(["error", a, a]);
      expect(out.detail).toBeUndefined();
    }
  });

  /*
   * A JUNK NUMBER IS DROPPED, NEVER FATAL. This runs on the failure path, where
   * the row matters far more than its detail — the same discipline
   * mail-backup.sh applies to its manifest ("the count is a convenience, never a
   * gate"). Throwing on an unparseable line number would turn a reportable
   * backup failure back into the silence this whole change removes.
   */
  it("still records the failure when the numbers are unusable", () => {
    const out = parseOutcome(["error", "not-a-line", "not-a-code"]);
    expect(out.status).toBe("error");
    expect(out.detail).toBeUndefined();
  });

  it("keeps whichever half is usable", () => {
    expect(parseOutcome(["error", "88", "junk"]).detail).toEqual({ failedLine: 88 });
    expect(parseOutcome(["error", "junk", "3"]).detail).toEqual({ exitStatus: 3 });
  });
});

describe("the worker name", () => {
  /*
   * THE CALLER CANNOT INFLUENCE IT, and this is the design constraint rather
   * than a style preference. declFor() defaults an unknown `worker_runs.worker`
   * to a WATCHER at 5 min × 3 — loud beats quiet, which is right for a worker
   * somebody forgot to declare and catastrophic for a TYPO: `mail-bakcup` would
   * be amber within fifteen minutes, permanently, and nothing could ever clear
   * it because no code path would write that name again. So there is exactly one
   * name, it is a constant, and no argument reaches recordRun's `worker`
   * parameter.
   */
  it("is one constant, shared with the taxonomy that reads it", () => {
    expect(BACKUP_WORKER).toBe("mail-backup");
    expect(BACKUP_WORKER).toBe(MAIL_BACKUP_WORKER_NAME);
  });

  it("is not something parseOutcome can return", () => {
    // The parsed outcome carries a status and two optional numbers. If a `worker`
    // ever appears here, the argv path has grown a way to choose the name.
    expect(Object.keys(parseOutcome(["error", "1", "2"]))).toEqual(["status", "detail"]);
    expect(Object.keys(parseOutcome(["error", "1", "2"]).detail ?? {}))
      .toEqual(["failedLine", "exitStatus"]);
  });

  /*
   * Asserted on the SOURCE, because the property is "there is no other way to
   * spell it" and no value returned from a pure function can show that. Resolved
   * from this file rather than the cwd, exactly as mail-backup.test.ts resolves
   * the shell script.
   */
  it("is written to the row from the imported constant and never from argv", () => {
    const src = readFileSync(new URL("./mail-backup-run.ts", import.meta.url), "utf8");
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    // Exactly one recordRun call, and it names the constant.
    expect(code.match(/recordRun\(/g)).toHaveLength(1);
    expect(code).toMatch(/recordRun\(db, BACKUP_WORKER,/);
    // The name literal appears nowhere in the executable half — it lives in
    // packages/api/src/worker-names.ts and arrives by import.
    expect(code).not.toMatch(/"mail-backup"/);
    expect(code).toMatch(/MAIL_BACKUP_WORKER_NAME/);
  });
});
