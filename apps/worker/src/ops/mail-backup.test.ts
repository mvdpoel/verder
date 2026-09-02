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
    // `-E` is errtrace and was added WITH the ERR trap below: without it the
    // trap does not fire inside a shell function, and cleanup_snapshot and the
    // tier-2 block are both functions' worth of the work that can fail. The
    // three original flags must survive it.
    expect(code).toMatch(/^set -Eeuo pipefail$/m);
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
    expect(code).toMatch(/trap\s+cleanup_snapshot\s+EXIT/);
    expect(code).toMatch(/start stalwart/);
    /*
     * And the trap must still be armed with a body that does the restarting.
     * Asserted on the FUNCTION BODY, sliced out rather than matched with a lazy
     * `[\s\S]*?` — MEASURED: a version of this test that let the match run on
     * from `cleanup_snapshot() {` passed with the restart deleted from the
     * function, because it found the unconditional `start stalwart` on the happy
     * path forty lines below. `trap cleanup_snapshot EXIT` beside a
     * cleanup_snapshot that no longer starts anything is the whole outage this
     * test exists to prevent, so the slice ends at the function's own closing
     * brace in column 0.
     */
    const body = code.slice(code.indexOf("cleanup_snapshot() {"));
    const fn = body.slice(0, body.indexOf("\n}") + 2);
    expect(fn).toMatch(/start stalwart/);
    expect(fn).toMatch(/\|\| true/);
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

  /*
   * THE SIDECAR MANIFEST — the baseline the monthly restore drill measures a
   * restored store against.
   *
   * Everything here is asserted on `code`, never on `sh`. The block it covers
   * carries about sixty lines of comment explaining what it deliberately does
   * NOT do — no filter, no `-e` with a value, no gate — and every one of those
   * sentences would satisfy a naive grep for the thing it forbids.
   */
  describe("restore-drill manifest", () => {
    // Boundaries of the manifest block, so the "no X anywhere near this" checks
    // cannot be satisfied — or broken — by tier 2 forty lines further down,
    // which legitimately does `run --rm` and legitimately passes an `-e`.
    const blockStart = code.indexOf('MANIFEST_JSON=""');
    const blockEnd = code.indexOf('STAGING="$ARCHIVE.partial"');
    const block = code.slice(blockStart, blockEnd);

    it("brackets the block the rest of these tests slice", () => {
      expect(blockStart).toBeGreaterThan(-1);
      expect(blockEnd).toBeGreaterThan(blockStart);
    });

    /*
     * ONE DEFINITION OF THE QUESTION. This block used to be a node heredoc that
     * built its own Basic header, fetched its own session, read primaryAccounts
     * and walked methodResponses — a SECOND JMAP client beside
     * mail/jmap-client.ts, reading JMAP_BASE_URL / JMAP_USER /
     * JMAP_APP_PASSWORD directly, against from-env.ts's own law ("NOTHING else
     * in `mail/` reads an env var for the connection … it is the only one").
     *
     * And it had already drifted from the drill that consumes its output, before
     * either half had ever run: it kept the LAST of two mailboxes sharing a name
     * where the drill SUMS them, and dropped a mailbox with no `totalEmails`
     * where the drill refuses one. Either difference fails rule 3 on a
     * byte-perfect restore, every month, permanently — which ends with nobody
     * reading the drill. Both halves now call mail/jmap-counts.ts.
     */
    it("asks over the worker's own JMAP client, never a second copy of one", () => {
      expect(block).toMatch(/pnpm --silent --filter worker mail-count/);
      // No hand-rolled client anywhere in the script: no session fetch, no
      // Basic header, no methodCalls, no method-response walking.
      expect(code).not.toMatch(/well-known\/jmap/);
      expect(code).not.toMatch(/methodCalls/);
      expect(code).not.toMatch(/methodResponses/);
      expect(code).not.toMatch(/primaryAccounts/);
      // The credential checks are BLOCK-scoped, not script-wide: tier 2 forty
      // lines below legitimately reads JMAP_APP_PASSWORD (to hand vandelay
      // `VANDELAY_PASSWORD`, name-only) and JMAP_BASE_URL. What matters here is
      // that the MANIFEST never touches them — the worker already holds them
      // through `env_file: .env.prod`.
      expect(block).not.toMatch(/JMAP_APP_PASSWORD/);
      expect(block).not.toMatch(/JMAP_BASE_URL/);
      expect(block).not.toMatch(/JMAP_USER/);
      expect(block).not.toMatch(/[Aa]uthorization|Basic /);
    });

    /*
     * MEASURED against production 2026-09-01: Email/query FILTERS RETURN
     * NOTHING on this store. A `subject` filter for a subject known to be
     * present returns 0, and so does `header: ["Message-ID"]` — which asks only
     * whether the header EXISTS and cannot honestly be zero across 146,270
     * messages. The query itself now lives in mail/jmap-counts.ts, where its own
     * test pins the request body; what this file can still say is that the
     * count is taken over that module and not over a filtered query of its own.
     *
     * NOTE WHAT THIS IS NOT: `expect(code).not.toMatch(/filter/i)` over the
     * whole script, which is what it used to be. `pnpm --filter worker <script>`
     * is how EVERY ops script in this repo invokes worker code, so that
     * assertion forbade the fix rather than the fault.
     */
    it("takes the count from the module that carries the no-filter measurement", () => {
      const counts = readFileSync(
        new URL("../mail/jmap-counts.ts", import.meta.url), "utf8");
      expect(counts).toMatch(/Email\/query/);
      expect(counts).toMatch(/calculateTotal: true/);
      expect(counts).toMatch(/Mailbox\/get/);
      expect(counts).toMatch(/properties: \["name", "totalEmails"\]/);
      // Summed, not last-wins — the drift that made this refactor necessary.
      expect(counts).toMatch(/totals\[name\] = \(totals\[name\] \?\? 0\) \+ row\.totalEmails/);
      // And a mailbox with no usable total throws rather than being dropped.
      expect(counts).toMatch(/no usable totalEmails/);
    });

    /*
     * THE COUNT IS TAKEN WHILE THE SERVER IS STILL UP. Taken after the restart
     * it would depend on Stalwart finishing its RocksDB open — the riskiest
     * minute in this script, and the last place to add a second consumer — and
     * in phase 2 mail delivered between `start` and the count would make the
     * baseline claim MORE messages than the archive holds, which is exactly the
     * false alarm the manifest exists to prevent.
     */
    it("reads the count before the store is stopped", () => {
      /*
       * ANCHORED ON THE MANIFEST INVOCATION, NOT ON `exec -T worker`, and that
       * is a repair rather than a preference. This test used to say
       * `code.indexOf("exec -T worker")`, which was the manifest read until
       * record_backup was added ABOVE it — after which the first occurrence was
       * the recorder at offset 779 and the manifest sat at 1524. MUTATION-TESTED
       * at the time: moving the whole `if ! COUNT_OUT=$(…)` block to AFTER
       * `stop stalwart` still gave 779 < 2118 and the test PASSED, so the
       * property below was pinned by nothing. The property is worth pinning —
       * reading the count after the stop makes it depend on Stalwart finishing
       * its RocksDB open, and in phase 2 makes the baseline claim MORE messages
       * than the archive holds — so the anchor names the manifest call itself.
       */
      const counted = code.indexOf("worker mail-count");
      const stopped = code.indexOf("stop stalwart");
      expect(counted).toBeGreaterThan(-1);
      expect(stopped).toBeGreaterThan(-1);
      expect(counted).toBeLessThan(stopped);
    });

    /*
     * A manifest is a claim about an archive, so it may not exist until the
     * archive does. Written before the `mv` it would sit beside a `.partial`
     * that a failed config.json verification is about to delete — a baseline
     * for a snapshot nobody ever took, which is the same class of artifact as
     * the 5.66 GB etc-less tar that taught this script to stage and rename.
     */
    it("writes the manifest only after the archive is verified and renamed", () => {
      const archiveMv = code.indexOf('mv -f "$STAGING" "$ARCHIVE"');
      const manifestMv = code.indexOf('mv -f "$MANIFEST.partial" "$MANIFEST"');
      expect(archiveMv).toBeGreaterThan(-1);
      expect(manifestMv).toBeGreaterThan(archiveMv);
      // Staged and renamed like the archive: `printf` is atomic only by luck,
      // and a torn manifest is a drill that cannot parse its own baseline.
      expect(code).toMatch(/printf '%s\\n' "\$MANIFEST_JSON" > "\$MANIFEST\.partial"/);
      // Nothing may write the real name directly.
      expect(code).not.toMatch(/> "\$MANIFEST"/);
    });

    /*
     * THE RULE THAT MATTERS MOST. A backup that stops happening because a
     * nice-to-have failed is a far worse outcome than a drill falling back to
     * the live count. Worker down, JMAP unreachable, docker daemon wedged —
     * every one of them warns and carries on, so the count must live inside a
     * condition (`set -e` does not kill there) and the block must hold no exit.
     */
    it("warns and carries on when the count cannot be taken", () => {
      expect(code).toMatch(/if ! COUNT_OUT=\$\(timeout 60 "\$\{COMPOSE\[@\]\}" exec -T worker/);
      // Exactly one invocation IN THIS BLOCK, so there is no unguarded second
      // one. Script-wide the count is two: the other is record_backup, which is
      // guarded by its own `||` for the same reason and is asserted where it
      // lives. A bare number here would have failed the day that was added and
      // taught the next reader to raise it instead of checking why.
      expect(block.match(/exec -T worker/g)).toHaveLength(1);
      expect(code.match(/exec -T worker/g)).toHaveLength(2);
      expect(block).toMatch(/COUNT_OUT=""/);
      // No shell `exit` anywhere in the block.
      expect(block).not.toMatch(/^\s*exit\b/m);
      expect(block).not.toMatch(/\|\| exit/);
    });

    /*
     * `pnpm run` prints a banner of its own on stdout and its wording belongs to
     * whichever pnpm the image carries. mail-count writes the manifest as one
     * line and every diagnosis to stderr, so the manifest is the line that
     * starts like a manifest; anything else is somebody else's noise and must
     * not reach the structural gate as a mystery.
     */
    it("takes the manifest line out of the output rather than trusting all of it", () => {
      expect(code).toMatch(/grep -m1 '\^\{"archive":"native-'/);
    });

    /*
     * The other half of that rule: no manifest is honest, a manifest saying 0
     * is a lie the drill would act on. The leading `[1-9]` is the whole point of
     * the pattern — it refuses an empty store, a query that matched nothing,
     * and any error text that reached stdout instead of stderr.
     */
    it("refuses to write a manifest with a wrong or empty count", () => {
      expect(code).toMatch(/"count":\[1-9\]\[0-9\]\*/);
      // The count < 1 refusal moved into mail-count.ts with the rest of it.
      const counter = readFileSync(
        new URL("./mail-count.ts", import.meta.url), "utf8");
      expect(counter).toMatch(/count < 1/);
      expect(counter).toMatch(/refusing to write a manifest/);
      // Both rejections null the payload, and the write is guarded ON THAT
      // EMPTINESS — asserted as the two adjacent lines, because `[ -n
      // "$MANIFEST_JSON" ]` also appears in the rejection above and a looser
      // match would survive the guard being deleted from the write.
      expect(code).toMatch(/if \[ -n "\$MANIFEST_JSON" \]; then\n\s*printf/);
    });

    /*
     * Manifests are the one thing this script writes that would otherwise
     * accumulate forever: `-name 'native-*.tar.zst'` cannot match a `.json`, so
     * without a second rule every baseline outlives its archive by years.
     */
    it("prunes the manifests on the same clock as the archives", () => {
      expect(code).toMatch(/find "\$OUT" -name 'native-\*\.tar\.zst' -mtime \+14 -delete/);
      expect(code).toMatch(/find "\$OUT" -name 'native-\*\.json\*' -mtime \+14 -delete/);
      // The trailing `*` sweeps a `.json.partial` orphaned by a killed run.
      expect("native-2026-09-01.json.partial").toMatch(/^native-.*\.json.*$/);
      expect("native-2026-09-01.json").not.toMatch(/^native-.*\.tar\.zst$/);
    });

    /*
     * `exec`, not `run --rm`, and the container start it saves is the lesser
     * reason: the worker already holds the credentials from `env_file:
     * .env.prod`, so this script never handles the secret at all — no `-e`, no
     * command line, no host process table, nothing in a cron log. Tier 2 cannot
     * do this because vandelay wants the password under a different name, which
     * is why it has to pass `-e VANDELAY_PASSWORD` name-only.
     */
    it("keeps the app password out of the process table", () => {
      // No docker env flag on the count, in either form.
      expect(block).not.toMatch(/-e [A-Z_]+/);
      expect(code).not.toMatch(/JMAP_APP_PASSWORD=/);
      // The count container is the one already running, never a new one.
      expect(block).not.toMatch(/run --rm/);
    });

    /*
     * TWO hangs, two bounds. There is NO request timeout anywhere else on the
     * JMAP path — jmap-client.ts passes no AbortSignal and undici's 300 s
     * default is all that is under it — and `docker compose exec` can hang on
     * its own for reasons the JS cannot reach. A convenience step that can hang
     * is a gate wearing a different hat: it would hold the whole nightly run,
     * and this one runs in front of the tar.
     */
    it("bounds both the JMAP call and the docker exec", () => {
      const counter = readFileSync(
        new URL("./mail-count.ts", import.meta.url), "utf8");
      expect(counter).toMatch(/AbortSignal\.timeout\(ms\)/);
      expect(counter).toMatch(/REQUEST_TIMEOUT_MS = \d[\d_]*/);
      expect(code).toMatch(/timeout 60 "\$\{COMPOSE\[@\]\}" exec/);
    });
  });

  /*
   * THE ROW THIS SCRIPT WRITES ABOUT ITSELF.
   *
   * THE HOLE, found 2026-09-02: this script recorded nothing the app can see,
   * and it is the LAST step of ops/nightly.sh — nightly-verify and model-check
   * have already written their green rows by the time it starts. A night where
   * the snapshot failed left the Systeem panel entirely green. The monthly drill
   * did not cover it either: ops/mail-restore-drill.sh takes the newest archive
   * by mtime and never asks how old it is, so it kept PASSING on a stale
   * archive. Green for fourteen days, until `find -mtime +14 -delete` removed
   * the last one and the drill failed with nothing left to restore.
   */
  describe("the worker_runs row", () => {
    it("records ok and error under a name it cannot get wrong", () => {
      expect(code).toMatch(/pnpm --silent --filter worker mail-backup-run "\$@"/);
      expect(code).toMatch(/record_backup error "\$line" "\$rc"/);
      expect(code).toMatch(/^record_backup ok$/m);
      // The shell chooses the STATUS and never the worker name: mail-backup-run
      // spells that from a constant, because declFor() defaults an unknown name
      // to a watcher at 5 min × 3 and one typo would be a permanently amber row
      // nothing could ever clear.
      expect(code).not.toMatch(/mail-backup-run [^"\n]*mail-backup\b/);
    });

    /*
     * ERR, NOT A SECOND EXIT TRAP, AND IT IS THE MOST IMPORTANT ASSERTION IN
     * THIS FILE. Bash allows exactly ONE EXIT trap at a time. This script juggles
     * three deliberately, and `trap cleanup_snapshot EXIT` is what guarantees the
     * mail server comes back up when a tar fails — a `trap … EXIT` added for the
     * reporting would silently replace it and leave stalwart DOWN on precisely
     * the night something went wrong. ERR is a separate trap and composes.
     */
    it("reports through ERR and adds no second EXIT trap", () => {
      expect(code).toMatch(/trap 'on_backup_error "\$\?" "\$LINENO"' ERR/);
      // The EXIT traps are exactly the three that were already here: the
      // snapshot cleanup, the tier-2 scratch removal, and nothing else. `trap -
      // EXIT` disarms and is counted separately.
      const armed = code.match(/^\s*trap\s+(?!-\s)\S.*\bEXIT\b/gm) ?? [];
      expect(armed).toHaveLength(2);
      expect(armed[0]).toMatch(/cleanup_snapshot/);
      expect(armed[1]).toMatch(/rm -rf '\$TMP'/);
    });

    /*
     * MEASURED, and nastier than it looks: an UNGUARDED failing command inside
     * an ERR handler does not re-enter the trap — bash suppresses ERR while the
     * handler runs — but it DOES overwrite the script's exit status. A run that
     * failed with rc=3 exited 1 instead, and nightly.sh and the cron log read
     * that status. A backup that cannot report its failure must still report the
     * failure honestly, so the recorder lives in a `||` list and the handler
     * returns 0 and lets `set -e` kill the script exactly as before.
     */
    it("cannot abort the script or rewrite its exit status while reporting", () => {
      expect(code).toMatch(/mail-backup-run "\$@" >\/dev\/null \|\| \{/);
      expect(code).toMatch(/on_backup_error\(\) \{[\s\S]*?\n\s*return 0\n\}/);
      /*
       * BOUNDED HARD, and `-k` is the assertion that matters. ERR fires BEFORE
       * the EXIT traps, so on any failure between `stop stalwart` and `start
       * stalwart` this call sits IN FRONT OF cleanup_snapshot's restart. A plain
       * `timeout 60` is not a ceiling on that at all: `docker compose exec` need
       * only ignore SIGTERM — a wedged docker daemon is one of the failure modes
       * the manifest block already lists — and the mail server stays down
       * indefinitely while the script waits to report. `-k 5` escalates to
       * SIGKILL, which bounds the outage the reporting can add at 65 s.
       */
      expect(code).toMatch(/timeout -k 5 60 "\$\{COMPOSE\[@\]\}" exec -T worker \\\n\s*pnpm --silent --filter worker mail-backup-run/);
    });

    /*
     * MEASURED: ERR fires AGAIN from inside an EXIT trap. A script that died at
     * line N, recorded it, and then hit a failing command in cleanup_snapshot ran
     * the handler a second time — two rows for one night, the second naming a
     * line in the cleanup rather than the line that broke. The flag also stops
     * the success and failure paths both writing.
     */
    it("writes one row per run and never two", () => {
      expect(code).toMatch(/backup_reported=0/);
      // Guard first, flag set before anything that can fail, then the call.
      expect(code).toMatch(
        /record_backup\(\) \{\n\s*if \[ "\$backup_reported" -ne 0 \]; then return 0; fi\n\s*backup_reported=1/);
    });

    /*
     * NOTHING BUT DIGITS REACHES worker_runs.detail. It is rendered on the
     * dashboard and dumped off-box by the nightly pg_dump, and this script is
     * the one place that handles the JMAP app password — which is why tier 2
     * passes `-e VANDELAY_PASSWORD` name-only. `$BASH_COMMAND` would name the
     * failing command and is deliberately not sent; bash was measured NOT to
     * expand it, but "the shell probably will not interpolate a credential into
     * a string we archive for a year" is not a guarantee worth building on.
     */
    it("sends only the failing line and the exit status", () => {
      expect(code).not.toMatch(/BASH_COMMAND/);
      const handler = code.slice(
        code.indexOf("on_backup_error() {"), code.indexOf("trap 'on_backup_error"));
      expect(handler).toMatch(/local rc="\$1" line="\$2"/);
      expect(handler).not.toMatch(/\$\{?(JMAP|VANDELAY|BACKUP_AGE)/);
      // mail-backup-run.ts is the other half of the guarantee, and it refuses
      // anything that is not a short run of digits.
      const runner = readFileSync(new URL("./mail-backup-run.ts", import.meta.url), "utf8");
      expect(runner).toMatch(/\/\^\\d\{1,6\}\$\//);
      expect(runner).toMatch(/expected ok or error/);
    });

    /*
     * ORDER. `record_backup ok` sits after BOTH tiers and both retention sweeps,
     * so there is no partial green: a night either got all the way to the end or
     * took the ERR path and recorded why. The weekly tier is inside an `if` that
     * can legitimately skip, but everything that can FAIL is above this line.
     */
    it("records ok only after the weekly tier and its retention sweep", () => {
      const weekly = code.indexOf("worker import jmap");
      const prune = code.indexOf("find \"$OUT\" -name 'archive-*.sqlite.zst*'");
      const ok = code.indexOf("\nrecord_backup ok");
      const done = code.indexOf("mail-backup.sh: done");
      expect(weekly).toBeGreaterThan(-1);
      expect(prune).toBeGreaterThan(weekly);
      expect(ok).toBeGreaterThan(prune);
      expect(done).toBeGreaterThan(ok);
    });

    /*
     * THE ASSERTION THAT WOULD HAVE CAUGHT THE HOLE THIS SUITE MISSED FIRST TIME.
     *
     * MEASURED (bash 5.3): THE ERR TRAP DOES NOT FIRE ON THE `exit` BUILTIN. A
     * script with `set -Eeuo pipefail`, `trap 'on_err …' ERR` and `trap cleanup
     * EXIT` whose `if ! grep -qx …; then exit 1; fi` fired printed only the EXIT
     * trap and rc=1 — the ERR handler was never called. The first version of this
     * change left two bare `exit 1`s in the script, and one of them was the
     * archive acceptance test: the single most important failure this script can
     * detect (an archive with no etc/config.json restores into BOOTSTRAP MODE on
     * an empty store) recorded NO ROW, so the panel would have shown last night's
     * `ok` on the night the backup produced something unrestorable. Every test in
     * this describe block passed while that was true, because each of them
     * asserted that `record_backup` EXISTS rather than that nothing escapes it.
     *
     * So this one is structural: the only `exit` in the whole file is the one
     * INSIDE backup_fail, which records first. Anything else must be a failing
     * command, which ERR catches.
     */
    it("has no exit that escapes the recorder", () => {
      expect(code).toMatch(/backup_fail\(\) \{\n\s*record_backup error "\$1" 1\n\s*exit 1\n\}/);
      const fail = code.indexOf("backup_fail() {");
      const outside = [...code.matchAll(/^\s*exit\b.*$/gm)]
        .filter((m) => {
          const at = m.index ?? 0;
          return at < fail || at > code.indexOf("\n}", fail);
        })
        .map((m) => m[0].trim());
      expect(outside).toEqual([]);
      // And all three deliberate refusals go through it, each carrying its own
      // `$LINENO` so the row names the check that fired: the archive acceptance
      // test, a missing `age` when BACKUP_AGE_RECIPIENT is set, and a vandelay
      // binary that cannot produce the weekly survival archive.
      expect(code.match(/backup_fail "\$LINENO"/g)).toHaveLength(3);
    });

    /*
     * A SKIPPED SURVIVAL TIER IS A FAILURE, NOT A GREEN NIGHT. The `if` above the
     * weekly block is a legitimate skip — six nights a week this week's archive
     * already exists. A vandelay binary that is not executable is not: it does not
     * heal, so the version-independent tier stops being produced FOREVER while
     * tier 1 keeps writing a perfectly good nightly snapshot. Warned on stderr and
     * allowed to fall through to `record_backup ok`, that is a green tile
     * asserting a two-tier backup on a machine taking one tier — the same
     * stderr-only failure behind a green surface this whole change removes, one
     * tier down, and a direct breach of this file's first line ("never a
     * generation where only the native form exists").
     */
    it("refuses to record ok when the weekly tier cannot be written at all", () => {
      const branch = code.slice(
        code.indexOf('if [ ! -x "$VANDELAY" ]; then'), code.indexOf("  else"));
      expect(branch).toMatch(/backup_fail "\$LINENO"/);
      expect(branch).not.toMatch(/record_backup ok/);
    });

    /*
     * The ERR trap must be armed before the first thing that can fail, or a
     * backup that died on `mkdir -p "$OUT"` — a NAS that did not mount, which is
     * a real and silent failure — would take the ERR path with no handler and go
     * unreported, which is the bug this whole change removes.
     */
    it("arms the trap before the first command that can fail", () => {
      const armed = code.indexOf("trap 'on_backup_error");
      const mkdir = code.indexOf('mkdir -p "$OUT"');
      const stop = code.indexOf("stop stalwart");
      expect(armed).toBeGreaterThan(-1);
      expect(mkdir).toBeGreaterThan(armed);
      expect(stop).toBeGreaterThan(armed);
    });
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
