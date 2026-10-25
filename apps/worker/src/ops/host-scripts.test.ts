import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, writeFileSync,
} from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";

// These run the REAL ops/nightly.sh and ops/watchdog.sh in a throwaway tree
// with stubbed docker/sudo/findmnt/... first on PATH, the way the mail-backup
// script was exercised. NO database: the row the scripts ask for is the line
// they send to the stubbed `docker compose exec worker pnpm ... <name>-run`.

const OPS = new URL("../../../../ops/", import.meta.url).pathname;
const trees: string[] = [];
afterEach(() => { for (const t of trees.splice(0)) rmSync(t, { recursive: true, force: true }); });

const STUBS: Record<string, string> = {
  // Drops `-k N` and the duration, then execs the rest.
  timeout: `#!/bin/sh
while :; do case "$1" in -k) shift 2;; -*) shift;; ''|*[!0-9]*) break;; *) shift; break;; esac; done
exec "$@"
`,
  docker: `#!/bin/sh
echo "docker $*" >> "$STUB_LOG"
case " $* " in
  *" pg_dump "*)
    case "$DUMP_MODE" in
      complete) echo "-- PostgreSQL database dump complete";;
      truncated) echo "-- partial";;
      fail) exit 1;;
    esac; exit 0;;
  *" ps -q "*) for svc; do :; done; [ -f "$STUB_STATE/$svc" ] && echo "id-$svc"; exit 0;;
  *" inspect "*) for id; do :; done; cat "$STUB_STATE/\${id#id-}"; exit 0;;
  *" test -f /scans/.verder-nas"*) exit "\${WORKER_MARKER_RC:-0}";;
  *" watchdog-run "*|*" db-backup-run "*) exit "\${RECORD_RC:-0}";;
esac
exit 0
`,
  findmnt: `#!/bin/sh
[ -n "$FINDMNT_TARGET" ] && echo "$FINDMNT_TARGET"
`,
  rsync: `#!/bin/sh
echo "rsync $*" >> "$STUB_LOG"
`,
  pgrep: `#!/bin/sh
exit "\${PGREP_RC:-1}"
`,
  mountpoint: `#!/bin/sh
grep -qx "$2" "$STUB_STATE/mounted" 2>/dev/null
`,
  sudo: `#!/bin/sh
echo "sudo $*" >> "$STUB_LOG"
if [ "$SUDO_MOUNT_OK" = 1 ]; then echo "$3" >> "$STUB_STATE/mounted"; touch "$3/.verder-nas"; exit 0; fi
exit 1
`,
};

function tree() {
  const root = mkdtempSync(join(tmpdir(), "host-scripts-"));
  trees.push(root);
  for (const d of ["ops", "bin", "state", "backup", "vault", "scan", "dl", "home"]) mkdirSync(join(root, d));
  for (const s of ["nightly.sh", "watchdog.sh"]) copyFileSync(join(OPS, s), join(root, "ops", s));
  writeFileSync(join(root, "ops/mail-backup.sh"), '#!/bin/sh\necho "mail-backup.sh ran" >> "$STUB_LOG"\n');
  chmodSync(join(root, "ops/mail-backup.sh"), 0o755);
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(root, "bin", name), body);
    chmodSync(join(root, "bin", name), 0o755);
  }
  const backup = join(root, "backup/verder-backups");
  writeFileSync(join(root, ".env.prod"), [
    `BACKUP_DIR=${backup}`, `VAULT_HOST_DIR=${join(root, "vault")}`,
    `NAS_SCAN_HOST_DIR=${join(root, "scan")}`, `WATCHDOG_BACKUP_MOUNT=${join(root, "dl")}`,
  ].join("\n") + "\n");
  writeFileSync(join(root, "stub.log"), "");
  return {
    root, backup, scan: join(root, "scan"), dl: join(root, "dl"),
    stubState: join(root, "state"), watchdogState: join(root, "home/wd"),
    log: () => readFileSync(join(root, "stub.log"), "utf8"),
    setService: (svc: string, state: string) => writeFileSync(join(root, "state", svc), state),
    mount: (path: string) => appendFileSync(join(root, "state/mounted"), path + "\n"),
    run(script: string, env: Record<string, string> = {}) {
      const r = spawnSync("/bin/bash", [join(root, "ops", script)], {
        encoding: "utf8", timeout: 30_000,
        env: {
          PATH: `${join(root, "bin")}:/usr/bin:/bin`, HOME: join(root, "home"),
          STUB_LOG: join(root, "stub.log"), STUB_STATE: join(root, "state"),
          WATCHDOG_STATE_DIR: join(root, "home/wd"), ...env,
        },
      });
      return { status: r.status, stderr: r.stderr };
    },
  };
}

describe("ops/nightly.sh backup guard", () => {
  const stamp = new Date().toLocaleDateString("sv");

  it("target on the root filesystem: no dump, no mirror, verify still runs, error row, exit 1", () => {
    const t = tree();
    const r = t.run("nightly.sh", { FINDMNT_TARGET: "/", DUMP_MODE: "complete" });
    expect(r.status).toBe(1);
    expect(existsSync(t.backup)).toBe(false);
    const log = t.log();
    expect(log).not.toContain("pg_dump");
    expect(log).not.toContain("rsync");
    expect(log).not.toContain("mail-backup.sh ran");
    expect(log).toContain("nightly-verify");
    expect(log).toContain("model-check");
    expect(log).toContain("db-backup-run error target-unmounted");
  });

  it("walks up to the nearest existing ancestor before asking findmnt", () => {
    const t = tree();
    // BACKUP_DIR does not exist yet; its parent exists and is a real mount.
    const r = t.run("nightly.sh", { FINDMNT_TARGET: "/mnt/nas-download", DUMP_MODE: "complete" });
    expect(r.status).toBe(0);
    expect(readdirSync(t.backup)).toContain(`db-${stamp}.sql.gz`);
  });

  for (const mode of ["truncated", "empty", "fail"]) {
    it(`mounted but dump is ${mode}: bad file removed, good same-day dump kept, error row, exit 1`, () => {
      const t = tree();
      mkdirSync(t.backup, { recursive: true });
      const good = gzipSync("-- PostgreSQL database dump complete\n");
      writeFileSync(join(t.backup, `db-${stamp}.sql.gz`), good);
      const r = t.run("nightly.sh", { FINDMNT_TARGET: "/mnt/nas-download", DUMP_MODE: mode });
      expect(r.status).toBe(1);
      expect(readdirSync(t.backup).filter((n) => n.startsWith("db-"))).toEqual([`db-${stamp}.sql.gz`]);
      expect(readFileSync(join(t.backup, `db-${stamp}.sql.gz`))).toEqual(good);
      const log = t.log();
      expect(log).toContain("db-backup-run error dump-incomplete");
      expect(log).toContain("nightly-verify");
      expect(log).toContain("rsync");
    });
  }

  it("mounted and complete: dump kept, ok row, mail backup runs, exit 0", () => {
    const t = tree();
    const r = t.run("nightly.sh", { FINDMNT_TARGET: "/mnt/nas-download", DUMP_MODE: "complete" });
    expect(r.status).toBe(0);
    const dump = join(t.backup, `db-${stamp}.sql.gz`);
    expect(existsSync(dump)).toBe(true);
    expect(readdirSync(t.backup)).toEqual([`db-${stamp}.sql.gz`]);
    const log = t.log();
    expect(log).toMatch(/db-backup-run ok\n/);
    expect(log).toContain("mail-backup.sh ran");
  });

  it("an unwritable row (postgres down) does not abort the script", () => {
    const t = tree();
    const r = t.run("nightly.sh", { FINDMNT_TARGET: "/mnt/nas-download", DUMP_MODE: "complete", RECORD_RC: "1" });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("could not record the db-backup 'ok' row");
  });
});

describe("ops/watchdog.sh", () => {
  const healthy = (t: ReturnType<typeof tree>) => {
    for (const s of ["postgres", "web", "worker", "stalwart"]) t.setService(s, "running healthy");
    writeFileSync(join(t.scan, ".verder-nas"), "");
    t.mount(t.dl);
  };
  const upCalls = (log: string) => log.split("\n").filter((l) => / (up|restart) /.test(l));
  const rowArgs = (log: string) => log.split("\n").filter((l) => l.includes("watchdog-run"));

  it("skips the whole run, with no row, while nightly/mail-backup/drill is running", () => {
    const t = tree();
    healthy(t);
    expect(t.run("watchdog.sh", { PGREP_RC: "0" }).status).toBe(0);
    expect(t.log()).toBe("");
  });

  it("all healthy: no action, ok row naming what it checked", () => {
    const t = tree();
    healthy(t);
    expect(t.run("watchdog.sh").status).toBe(0);
    const log = t.log();
    expect(upCalls(log)).toEqual([]);
    expect(rowArgs(log)).toHaveLength(1);
    expect(rowArgs(log)[0]).toContain(
      "--checked postgres,web,worker,stalwart,nas-workspace,nas-download --restarted  --problems");
  });

  it("acts only on the SECOND consecutive bad check, then resets the count", () => {
    const t = tree();
    healthy(t);
    t.setService("web", "exited none");
    t.run("watchdog.sh");
    expect(upCalls(t.log())).toEqual([]);
    expect(readFileSync(join(t.watchdogState, "bad.web"), "utf8").trim()).toBe("1");
    t.run("watchdog.sh");
    expect(upCalls(t.log()).map((l) => l.replace(/.*yml /, ""))).toEqual(["up -d web"]);
    expect(existsSync(join(t.watchdogState, "bad.web"))).toBe(false);
    expect(rowArgs(t.log()).pop()).toContain("--restarted web --problems");
    expect(readFileSync(join(t.watchdogState, "watchdog.log"), "utf8")).toContain("web down -> up -d web ok");
  });

  it("a recovery between the two checks clears the strike", () => {
    const t = tree();
    healthy(t);
    t.setService("stalwart", "exited none");
    t.run("watchdog.sh");
    t.setService("stalwart", "running healthy");
    t.run("watchdog.sh");
    t.setService("stalwart", "exited none");
    t.run("watchdog.sh");
    expect(upCalls(t.log())).toEqual([]);
  });

  it("a service compose does not know at all counts as down", () => {
    const t = tree();
    healthy(t);
    rmSync(join(t.stubState, "postgres"));
    t.run("watchdog.sh");
    t.run("watchdog.sh");
    expect(upCalls(t.log()).map((l) => l.replace(/.*yml /, ""))).toEqual(["up -d postgres"]);
  });

  it("running but unhealthy gets `restart`, because `up -d` would be a no-op", () => {
    const t = tree();
    healthy(t);
    t.setService("worker", "running unhealthy");
    t.run("watchdog.sh");
    t.run("watchdog.sh");
    expect(upCalls(t.log()).map((l) => l.replace(/.*yml /, ""))).toEqual(["restart worker"]);
  });

  it("host has the marker but the worker's bind is stale: recreates the worker", () => {
    const t = tree();
    healthy(t);
    t.run("watchdog.sh", { WORKER_MARKER_RC: "1" });
    expect(upCalls(t.log()).map((l) => l.replace(/.*yml /, "")))
      .toEqual(["up -d --force-recreate --no-deps worker"]);
    expect(rowArgs(t.log()).pop()).toContain("--restarted worker --problems");
  });

  it("host lacks the marker: mounts it, then still checks the container", () => {
    const t = tree();
    healthy(t);
    rmSync(join(t.scan, ".verder-nas"));
    writeFileSync(join(t.stubState, "mounted"), `${t.dl}\n`);
    t.run("watchdog.sh", { SUDO_MOUNT_OK: "1", WORKER_MARKER_RC: "1" });
    const log = t.log();
    expect(log).toContain(`sudo -n mount ${t.scan}`);
    expect(upCalls(log).map((l) => l.replace(/.*yml /, "")))
      .toEqual(["up -d --force-recreate --no-deps worker"]);
    expect(rowArgs(log).pop()).toContain("--restarted nas-workspace,worker --problems");
  });

  it("host lacks the marker and mount fails: no restart, a problem on the row", () => {
    const t = tree();
    healthy(t);
    rmSync(join(t.scan, ".verder-nas"));
    t.run("watchdog.sh", { WORKER_MARKER_RC: "1" });
    expect(upCalls(t.log())).toEqual([]);
    expect(rowArgs(t.log()).pop()).toContain("--problems scan-mount-missing");
  });

  it("backup share not a mountpoint: tries to mount it", () => {
    const t = tree();
    healthy(t);
    writeFileSync(join(t.stubState, "mounted"), "");
    t.run("watchdog.sh", { SUDO_MOUNT_OK: "1" });
    expect(t.log()).toContain(`sudo -n mount ${t.dl}`);
    expect(rowArgs(t.log()).pop()).toContain("--restarted nas-download --problems");
  });

  it("row write failure (postgres down): stderr, exit 0, heal reported by the next run", () => {
    const t = tree();
    healthy(t);
    t.setService("web", "exited none");
    t.run("watchdog.sh", { RECORD_RC: "1" });
    const r = t.run("watchdog.sh", { RECORD_RC: "1" });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("could not record the watchdog row");
    t.setService("web", "running healthy");
    t.run("watchdog.sh");
    expect(rowArgs(t.log()).pop()).toContain("--restarted web --problems");
    expect(existsSync(join(t.watchdogState, "pending-restarted"))).toBe(false);
  });

  it("keeps all state under the state dir, nothing inside the repo tree", () => {
    const t = tree();
    healthy(t);
    t.setService("web", "exited none");
    t.run("watchdog.sh");
    expect(readdirSync(t.root).sort()).toEqual(
      ["backup", "bin", "dl", "home", "ops", "scan", "state", "stub.log", "vault", ".env.prod"].sort());
  });
});
