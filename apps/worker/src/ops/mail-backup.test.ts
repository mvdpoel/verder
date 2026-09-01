import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Resolved from THIS FILE, never from the cwd. `readFileSync("ops/…")` only
// works when vitest happens to run from the repo root, and the canonical
// command for this package runs from apps/worker — where it would throw ENOENT
// and read as "the script is missing" rather than "the test is wrong".
const sh = readFileSync(new URL("../../../../ops/mail-backup.sh", import.meta.url), "utf8");
const nightly = readFileSync(new URL("../../../../ops/nightly.sh", import.meta.url), "utf8");

/**
 * The script with comment-only lines removed.
 *
 * Assertions about what the script DOES must not be satisfiable by what it
 * SAYS. Both of the negative checks below were written against the whole file
 * first and both passed for the wrong reason: this script documents
 * `${STALWART_DATA_DIR:?}` and `--auth-password` at length as the two things it
 * deliberately does not do, so a plain `not.toMatch` found them in the prose and
 * called the code broken. A grep-the-file test is worth exactly as much as the
 * file's comment density, which in this repo is high.
 */
const code = sh.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

describe("mail-backup.sh", () => {
  it("fails loudly rather than silently skipping", () => {
    expect(sh).toMatch(/set -euo pipefail/);
  });

  /*
   * THE RESTORE-BREAKING ONE. 0.16 writes /etc/stalwart/config.json itself at
   * the end of the setup wizard, and a store restored without it comes up in
   * BOOTSTRAP MODE offering to build a second store beside the good one — a
   * restore that appears to succeed and serves an empty mailbox. The plan's
   * script tarred $STALWART_DATA_DIR alone.
   */
  it("backs up all three bind mounts, not just the data store", () => {
    expect(sh).toMatch(/STALWART_ETC_DIR/);
    expect(sh).toMatch(/STALWART_DATA_DIR/);
    expect(sh).toMatch(/STALWART_BLOB_DIR/);
  });

  /*
   * The three STALWART_* variables are genuinely ABSENT from .env.prod —
   * docker-compose.prod.yml defaults them, and documents at length why a `:?`
   * anywhere near that service breaks unrelated compose commands. A `:?` here
   * would abort the backup every night; a DIFFERENT default would back up a
   * path nothing runs from. Both are silent, so both are pinned.
   */
  it("defaults the store paths exactly as the compose file does", () => {
    for (const d of ["etc", "data", "blobs"]) {
      expect(sh).toContain(`/mnt/data/verder/stalwart/${d}`);
    }
    expect(code).not.toMatch(/STALWART_(ETC|DATA|BLOB)_DIR:\?/);
  });

  /*
   * Without the trap, a failing tar exits under `set -e` with the mail server
   * STOPPED — and phase 1's only tell would be a red `mail` row three minutes
   * later. The backup must never be able to take the service down with it.
   */
  it("always restarts stalwart, even when the snapshot fails", () => {
    expect(sh).toMatch(/trap\s+cleanup_snapshot\s+EXIT/);
    expect(code).toMatch(/start stalwart/);
  });

  /*
   * MEASURED ON THE FIRST REAL RUN, and it is why grep tests are not enough.
   * tar died on `etc: Cannot open: Permission denied`, CARRIED ON past the
   * error as tar does, and zstd wrote 5.66 GB holding data/ and blobs/ but not
   * etc/ — exactly the restore-into-bootstrap-mode artifact the test above
   * forbids, sitting on the NAS with a plausible name and size. A partial that
   * survives is worse than a failure, because only the failure is honest.
   */
  it("removes the staging file when the snapshot did not complete", () => {
    expect(code).toMatch(/snapshot_ok=0/);
    expect(code).toMatch(/rm -f "\$STAGING"/);
    expect(code).toMatch(/snapshot_ok=1/);
  });

  /*
   * MEASURED, and caused by the previous fix rather than by the plan. `zstd -o`
   * REFUSES to overwrite, so a second run on the same day failed instantly,
   * snapshot_ok stayed 0, and the cleanup deleted the VERIFIED 5.59 GB archive
   * the earlier run had written. A cron retry would have done the same. Staging
   * to `.partial` and renaming only after verification — the crash-safe shape
   * packages/api/src/storage.ts already uses for the vault — means a failed run
   * cannot touch an archive that already exists, and the real name never exists
   * incomplete.
   */
  it("never lets a failed run destroy the archive already in place", () => {
    expect(code).toMatch(/STAGING="\$ARCHIVE\.partial"/);
    expect(code).toMatch(/zstd -q -o "\$STAGING"/);
    expect(code).toMatch(/mv -f "\$STAGING" "\$ARCHIVE"/);
    // The destructive path must name the staging file and nothing else.
    expect(code).not.toMatch(/rm -f "\$ARCHIVE"/);
  });

  /*
   * "exited 0 is not evidence that anything arrived" — the lesson the Vandelay
   * import already wrote down, applied to the one member whose absence is
   * invisible until the day someone restores.
   */
  it("reads the archive back and requires config.json to be in it", () => {
    expect(code).toMatch(/tar -tf -/);
    expect(code).toMatch(/config\.json/);
    expect(sh).toMatch(/BOOTSTRAP MODE/);
  });

  /*
   * etc/ is 0750 owned by uid 2000, so the cron user cannot open it. sudo goes
   * on the TAR only: zstd must stay unprivileged or the archive lands on the
   * NAS owned by root and the retention find -delete can never remove it.
   */
  it("reads the store with sudo but writes the archive without it", () => {
    expect(code).toMatch(/sudo tar/);
    expect(code).not.toMatch(/sudo zstd/);
  });

  /*
   * FORMAT IS THE LOAD-BEARING DECISION (spec §2): a native snapshot depends on
   * the same pre-1.0 Stalwart reading its own on-disk format, so there must
   * never be a generation where only the native form exists.
   *
   * NOTE what this asserts and what it does not. The spec asked for MAILDIR and
   * this is a Vandelay SQLite archive, because `vandelay export --format
   * maildir` does not exist — measured against the binary, whose `export` only
   * pushes an archive INTO a JMAP server. The second tier is real (it does not
   * depend on the RocksDB layout) but it is weaker than specified, and the
   * script says so in the file rather than in a commit message nobody rereads.
   */
  it("writes a second, version-independent tier beside the native snapshot", () => {
    expect(sh).toMatch(/vandelay|import jmap/i);
    expect(sh).toMatch(/archive-\$WEEK/);
    expect(sh).toMatch(/NOT Maildir/i);
  });

  it("encrypts before anything leaves for a third party", () => {
    expect(sh).toMatch(/age -r/);
    // Set-but-unusable must fail rather than quietly write plaintext under a
    // name that says it is encrypted.
    expect(sh).toMatch(/BACKUP_AGE_RECIPIENT is set but/);
  });

  /*
   * mktemp's default is /tmp, which is on `/` with ~40 GB free; the weekly
   * archive is ~12.5 GB before compression. Filling root on the machine that
   * holds the ledger is a worse outcome than a missed backup.
   */
  it("stages the weekly pull off the root filesystem", () => {
    expect(sh).toMatch(/MAIL_BACKUP_SCRATCH/);
    expect(code).toMatch(/mktemp -d "\$SCRATCH_ROOT/);
  });

  /*
   * /mnt/data/verder is root-owned 0755, so the cron user cannot mkdir inside
   * it — measured, and only AFTER tier 1 had already succeeded, which is the
   * shape that matters: a script needing a manual mkdir before it fully works
   * does half its job in silence on a rebuilt machine, and a rebuilt machine is
   * precisely what a backup exists for.
   */
  it("creates its own scratch directory rather than assuming one", () => {
    expect(code).toMatch(/sudo mkdir -p "\$SCRATCH_ROOT"/);
    expect(code).toMatch(/sudo chown .* "\$SCRATCH_ROOT"/);
  });

  it("keeps the app password out of the process table", () => {
    expect(code).toMatch(/VANDELAY_PASSWORD=/);
    expect(code).not.toMatch(/--auth-password/);
    // `-e NAME` passes through from the environment; `-e NAME=value` would put
    // the secret on the docker command line for every user on the box.
    expect(code).toMatch(/-e VANDELAY_PASSWORD\b/);
    expect(code).not.toMatch(/-e VANDELAY_PASSWORD=/);
  });

  /*
   * MEASURED: `JMAP_BASE_URL` is http://stalwart:8080 and that name resolves
   * only between containers — on the host, `failed to lookup address
   * information: Try again`. deploy.md §8.7's /etc/hosts line would fix it and
   * is host-wide state a rebuilt machine will not have; pointing at
   * 127.0.0.1:8080 would not, because the session still hands back apiUrl
   * http://stalwart:8080/jmap/. So the pull runs inside the network.
   */
  it("pulls the weekly archive from inside the compose network", () => {
    expect(code).toMatch(/run --rm -T --no-deps/);
    expect(code).toMatch(/--entrypoint \/usr\/local\/bin\/vandelay/);
    // As the calling user, or a 12.5 GB root-owned archive lands on /mnt/data
    // that the cleanup cannot remove.
    expect(code).toMatch(/--user "\$\(id -u\):\$\(id -g\)"/);
  });
});

describe("nightly.sh", () => {
  /*
   * ORDER MATTERS, and it is the reason this is asserted at all. nightly.sh is
   * `set -euo pipefail`, so any step that fails skips every step after it. The
   * plan put the mail backup after the vault mirror — ahead of nightly-verify,
   * the ledger integrity check — which would let a 7 GB tar failure suppress
   * the one job that proves the evidence chain is intact.
   */
  it("runs the mail backup after nightly-verify, never before it", () => {
    const verify = nightly.indexOf("nightly-verify");
    const mail = nightly.indexOf("mail-backup.sh");
    expect(verify).toBeGreaterThan(-1);
    expect(mail).toBeGreaterThan(-1);
    expect(mail).toBeGreaterThan(verify);
  });
});
