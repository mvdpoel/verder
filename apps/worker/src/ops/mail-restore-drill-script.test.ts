import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * WHAT THIS TEST IS WORTH, stated plainly because the alternative is that
 * someone reads a green suite as evidence the backup restores.
 *
 * It is a grep over two files. It is a FLOOR and nothing more. It cannot start
 * a container, cannot extract a 7 GB archive, cannot notice that Stalwart
 * refuses the store, and cannot tell a restored server from production. Every
 * proposition it checks is of the form "the script still SAYS the thing that
 * was measured the hard way" — a regression fence around decisions whose reasons
 * are invisible in the diff that removes them.
 *
 * THE ONLY EVIDENCE THAT MATTERS IS THE REAL RUN. This whole task exists because
 * the plan's version of the restore drill was a pure boolean over mocked
 * dependencies: a green test over a backup nobody had ever restored. Do not let
 * this file become the same thing one level up.
 *
 * What it is genuinely good for is the class of mistake that is SILENT in
 * production: a cleanup that takes the live stack down, a scratch server that
 * hands back production's apiUrl, a published port, a `:?` that breaks the
 * nightly cron of an unrelated service. Each of those runs green on the day it
 * is introduced.
 */

// Resolved from THIS FILE, never from the cwd — the canonical command for this
// package runs from apps/worker, where readFileSync("ops/…") throws ENOENT and
// reads as "the script is missing" rather than "the test is wrong".
const sh = readFileSync(new URL("../../../../ops/mail-restore-drill.sh", import.meta.url), "utf8");
const yml = readFileSync(new URL("../../../../ops/mail-drill.compose.yml", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

/**
 * The files with comment-only lines removed.
 *
 * Assertions about what these files DO must not be satisfiable by what they
 * SAY. Both of them document at length the things they deliberately do NOT do —
 * `down`, `--remove-orphans`, `${VAR:?}`, publishing a port, inheriting
 * production's public url — so every negative check below finds its own prose
 * unless the comments are stripped first. mail-backup.test.ts learned this the
 * same way: a grep-the-file test is worth exactly as much as the file's comment
 * density, which in this repo is high.
 */
const strip = (s: string) => s.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const code = strip(sh);
const ymlCode = strip(yml);

describe("mail-restore-drill.sh", () => {
  it("fails loudly rather than silently skipping", () => {
    expect(sh).toMatch(/set -euo pipefail/);
  });

  /*
   * THE OVERLAY TRAP, and it is the one that could take the dossier offline.
   * The scratch service is defined as an overlay ON the production project so it
   * joins verder_default and the worker can resolve it by name. The price is
   * that `docker compose -f prod -f overlay down` means DOWN THE WHOLE PROJECT:
   * postgres, web, worker and the production stalwart. A cleanup path that used
   * it would end the drill by stopping the mail server and print a successful
   * drill while doing it.
   */
  it("cleans up by service name and can never take production down", () => {
    expect(code).toMatch(/rm -sf stalwart-drill/);
    // No `compose … down`, in any spelling, anywhere in the executable text.
    expect(code).not.toMatch(/compose[^\n]*\bdown\b/);
    expect(code).not.toMatch(/\{COMPOSE\[@\]\}"?\s+down\b/);
    expect(code).not.toMatch(/\{DRILL\[@\]\}"?\s+down\b/);
    // --remove-orphans reaps whatever is not in the file set it is given, which
    // is production's services when aimed at the overlay pair from the wrong
    // side. There is no correct use of it here.
    expect(code).not.toMatch(/--remove-orphans/);
    // `stop` without a service name stops the project.
    expect(code).not.toMatch(/\bstop\s*$/m);
  });

  /*
   * The trap must run on EVERY exit path — including the failures, which are the
   * ones that leave a 7 GB scratch tree and a running second mail server behind.
   */
  it("always removes the scratch service and the scratch tree", () => {
    expect(code).toMatch(/trap\s+cleanup\s+EXIT/);
    expect(code).toMatch(/sudo rm -rf -- "\$SCRATCH"/);
  });

  /*
   * AND VERIFIES THE CONTAINER IS GONE, which is the half with production blast
   * radius. `rm -sf` renders BOTH compose files, so it fails whenever the merged
   * config fails to render or the daemon hiccups; discarding its exit code left
   * a full second Stalwart on `verder_default` serving a month-old copy of the
   * whole dossier, with its store deleted out from under it, while the drill
   * printed PASS. The check does NOT go back through compose — the case that
   * matters is a compose invocation that cannot run, and asking the broken tool
   * whether it worked answers "nothing found" either way.
   */
  it("verifies the scratch container is actually gone, and reddens the run if it is not", () => {
    expect(code).not.toMatch(/rm -sf stalwart-drill[^\n]*>\/dev\/null 2>&1 \|\| true/);
    expect(code).toMatch(/docker ps -aq/);
    expect(code).toMatch(/label=com\.docker\.compose\.service=stalwart-drill/);
    expect(code).toMatch(/A SCRATCH STALWART IS STILL RUNNING/);
    // `if`, never `[ … ] && rc=1`: a short-circuited `&&` list is a FAILING
    // statement, and a failing statement inside the EXIT trap ends the trap
    // early — which would skip the scratch removal on exactly the runs that
    // already went wrong.
    expect(code).not.toMatch(/\[ "\$rc" -eq 0 \] && rc=1/);
    expect(code.match(/if \[ "\$rc" -eq 0 \]; then rc=1; fi/g)).toHaveLength(2);
  });

  /*
   * ONE DRILL AT A TIME. Two runs share one compose service name, so a second
   * `up -d stalwart-drill` recreates the container onto ITS store — killing the
   * first drill's server mid-probe — and the first drill's trap then removes the
   * second's container. The header invites exactly this by documenting a hand
   * run against the second-newest archive.
   */
  it("refuses to run beside another drill", () => {
    expect(code).toMatch(/flock -n 9/);
    expect(code).toMatch(/exec 9>"\$LOCK"/);
    expect(code).toMatch(/refusing to start a second/);
  });

  /*
   * MEASURED (docs/deploy.md §8, trap 5): `sudo rm -rf <dir>/*` SILENTLY DOES
   * NOTHING on the extracted etc/. That directory is 0750 owned by uid 2000, so
   * the glob is expanded by the UNPRIVILEGED shell before sudo runs, matches
   * nothing, and rm exits 0 having removed nothing — data/ and blobs/ were wiped
   * and etc/config.json survived. Naming the directory has no glob to misfire,
   * and the removal is VERIFIED rather than trusted, the same discipline
   * mail-backup.sh applies to tar.
   */
  it("removes the scratch tree in a form the glob trap cannot defeat, and verifies it", () => {
    expect(code).not.toMatch(/rm -rf[^\n]*\/\*/);
    expect(code).toMatch(/if \[ -e "\$SCRATCH" \]/);
    expect(code).toMatch(/FAILED to remove scratch dir/);
  });

  /*
   * The trap holds two `rm -rf`s worth of authority. It must be impossible for
   * either to name the live store — so the scratch root is refused up front if
   * it sits anywhere near it, before a single directory is created.
   */
  it("refuses a scratch root inside the live mail store", () => {
    expect(code).toMatch(/PROD_ROOT=\$\(dirname "\$PROD_DATA"\)/);
    expect(code).toMatch(/case "\$SCRATCH_ROOT" in/);
    expect(code).toMatch(/MAIL_DRILL_SCRATCH/);
    // The drill's own paths are never production's.
    expect(code).toMatch(/mail-drill-tmp/);
    expect(code).not.toMatch(/SCRATCH_ROOT:-\/mnt\/data\/verder\/stalwart/);
    expect(code).not.toMatch(/STORE="\/mnt\/data\/verder\/stalwart/);
  });

  /*
   * sudo ON THE TAR so the archive's uid/gid 2000 survives the extract. An
   * unprivileged extract lands the tree owned by the cron user, the container
   * (uid 2000) cannot read its own database, and the drill fails looking like a
   * Stalwart bug rather than a permissions bug — an hour on the wrong question,
   * every month.
   */
  it("extracts under sudo so the store keeps its uid 2000 ownership", () => {
    expect(code).toMatch(/sudo tar -C "\$STORE" -xf -/);
  });

  /*
   * THE RESTORE-BREAKING ONE, checked on the EXTRACTED REALITY rather than on
   * the archive's index — a different claim from mail-backup.sh's write-time
   * check (a truncated member, a partial extract, a full disk all pass that one).
   * Without config.json the server comes up in BOOTSTRAP MODE on an EMPTY store,
   * which connects fine and counts zero mail: a drill that reports "the backup
   * is broken" when nothing was ever restored.
   */
  it("asserts etc/config.json exists after extraction", () => {
    expect(code).toMatch(/test -s "\$STORE\/etc\/config\.json"/);
    expect(sh).toMatch(/BOOTSTRAP MODE/);
  });

  /*
   * An unbounded wait in a cron job is a hang nobody sees: no output, no
   * failure, no notification, and the trap never runs so the scratch tree and
   * the second mail server both survive.
   */
  it("waits for health with a bound and reports the container's own logs", () => {
    expect(code).toMatch(/MAIL_DRILL_HEALTH_TIMEOUT:-\d+/);
    expect(code).toMatch(/waited=\$\(\(waited \+ 5\)\)/);
    expect(code).toMatch(/\[ "\$waited" -ge "\$HEALTH_TIMEOUT" \]/);
    expect(code).toMatch(/docker logs --tail \d+ "\$CID"/);
    expect(code).toMatch(/State\.Health\.Status/);
  });

  /*
   * The TS side treats a MISSING tier 2 as a failure on purpose: tier 1 depends
   * on the pre-1.0 on-disk format, so "we forgot to look" and "the survival copy
   * is fine" must never render the same. Every branch here therefore ends in
   * JSON — a count, or a stated reason.
   */
  it("always emits tier-2 JSON, including a reason when it is skipped", () => {
    expect(code).toMatch(/tier2_skip\(\)/);
    expect(code).toMatch(/MAIL_DRILL_TIER2="\{\\"skipped\\":/);
    expect(code).toMatch(/\\"emails\\":\$tier2_count/);
    expect(code).toMatch(/export MAIL_DRILL_TIER2/);
    // The three known skips: no archive, encrypted archive, no vandelay.
    expect(code).toMatch(/no archive-\*\.sqlite\.zst/);
    expect(code).toMatch(/age-encrypted/);
    expect(code).toMatch(/vandelay not executable/);
  });

  /*
   * `vandelay inspect`'s output format WAS unverified when this parser was
   * written; it was measured on the homelab on 2026-09-01 and the captured
   * output now drives the execution test at the bottom of this file. What has
   * not changed is the rule: a parse miss is reported as a skip carrying the
   * real first line, never as an invented number and never as a failure of the
   * backup — vandelay printing something unexpected says nothing at all about
   * whether the archive is sound.
   */
  it("never invents a tier-2 count when the parse fails", () => {
    expect(code).toMatch(/could not parse vandelay inspect output/);
    expect(code).toMatch(/\$VANDELAY" inspect/);
    // The measurement is recorded next to the parser, so a later reader tuning
    // the regex can see what it was actually tuned against.
    expect(sh).toMatch(/MEASURED 2026-09-01/);
    expect(sh).toMatch(/THOUSANDS SEPARATOR/);
  });

  /*
   * ~12.5 GB decompressed. /tmp is on `/` with ~40 GB free; filling root on the
   * machine that holds the ledger is a worse outcome than a missed drill — the
   * same reason mail-backup.sh keeps its weekly pull off the root filesystem.
   */
  it("decompresses the weekly archive into the scratch root, never /tmp", () => {
    expect(code).toMatch(/zstd -dq -o "\$SCRATCH\/archive\.sqlite"/);
    expect(code).not.toMatch(/\/tmp\//);
  });

  /*
   * `-e NAME` passes the value from the environment; `-e NAME=value` puts it in
   * the process table for every user on the box. Nothing passed here is secret —
   * the JMAP credentials arrive through the worker's own env_file — but the
   * habit is what keeps the one that IS secret out of `ps`, which is exactly
   * what mail-backup.sh records for VANDELAY_PASSWORD.
   */
  it("passes variables through by name, never by value", () => {
    for (const v of [
      "MAIL_DRILL_BASE_URL",
      "MAIL_DRILL_ARCHIVE",
      "MAIL_DRILL_MANIFEST",
      "MAIL_DRILL_TIER2",
      "MAIL_DRILL_SAMPLES",
    ]) {
      expect(code).toMatch(new RegExp(`-e ${v}\\b`));
      expect(code).not.toMatch(new RegExp(`-e ${v}=`));
    }
    // And the app password is never named on a command line at all.
    expect(code).not.toMatch(/JMAP_APP_PASSWORD/);
  });

  /*
   * The worker mounts /vault, /scans and /repo/secrets and nothing else, so the
   * NAS backup directory is invisible inside the container and MAIL_DRILL_MANIFEST
   * would name an unreadable path. It is mounted for this one run, READ-ONLY:
   * the drill reads backups and must never be able to write one.
   */
  it("bind-mounts the backup directory read-only so the manifest is readable", () => {
    expect(code).toMatch(/-v "\$OUT:\/mail-backups:ro"/);
    expect(code).toMatch(/MAIL_DRILL_MANIFEST="\/mail-backups\//);
  });

  /*
   * TWO FILES SPELL ONE CONVENTION. mail-backup.sh writes the sidecar as
   * `$OUT/native-$STAMP.json` beside `$OUT/native-$STAMP.tar.zst`; the drill
   * derives it back with `${ARCHIVE%.tar.zst}.json`. Rename it on either side
   * and nothing breaks loudly — the drill just stops finding a manifest and
   * silently falls back to comparing against the LIVE count, which is the weaker
   * test and is indistinguishable from a night the manifest could not be taken.
   * So the agreement is asserted mechanically, from the writer's own line.
   */
  it("derives the manifest name from the one mail-backup.sh writes", () => {
    const backup = readFileSync(new URL("../../../../ops/mail-backup.sh", import.meta.url), "utf8");
    const written = backup.match(/^MANIFEST="([^"]+)"/m)?.[1];
    expect(written).toBe("$OUT/native-$STAMP.json");
    expect(code).toMatch(/MANIFEST_HOST="\$\{ARCHIVE%\.tar\.zst\}\.json"/);
  });

  it("runs the assertions from inside the compose network", () => {
    expect(code).toMatch(/run --rm -T --no-deps/);
    expect(code).toMatch(/worker pnpm --filter worker mail-drill/);
    expect(code).toMatch(/MAIL_DRILL_BASE_URL="http:\/\/stalwart-drill:8080"/);
  });

  /*
   * mail-backup.sh keeps five weeks of tier-2 archives so "a monthly restore
   * drill always has a second-newest to fall back on if the newest is the one
   * that turns out to be broken". That promise is only kept if the drill can be
   * pointed at a specific file.
   */
  it("lets a human drill a specific archive instead of the newest", () => {
    expect(code).toMatch(/ARCHIVE="\$OUT\/\$1"/);
    expect(code).toMatch(/no such archive/);
    expect(code).toMatch(/no native-\*\.tar\.zst in \$OUT/);
  });

  it("propagates the TS exit code", () => {
    expect(code).toMatch(/DRILL_RC=\$\?/);
    expect(code).toMatch(/exit "\$DRILL_RC"/);
  });

  /*
   * NOTHING IN THIS REPO INSTALLS THE CRONTAB, so the line in this header is
   * what an operator copies — and worker-health.ts's 35-day staleness bound is
   * reasoned FROM that schedule. Two spellings of one fact is how a later reader
   * ends up unable to tell which is the fact; this pins all three together.
   */
  it("documents the same schedule worker-health.ts and deploy.md reason from", () => {
    const health = readFileSync(
      new URL("../../../../packages/api/src/worker-health.ts", import.meta.url), "utf8");
    const deploy = readFileSync(
      new URL("../../../../docs/deploy.md", import.meta.url), "utf8");
    expect(sh).toContain("30 5 1 * *");
    // NOTE "30 5 1 * *" CONTAINS "0 5 1 * *", so a plain not-contains would
    // fail on the correct line. The anchor is what distinguishes them.
    expect(sh).not.toMatch(/^#\s+0 5 1 \* \*/m);
    expect(health).toContain("30 5 1 * *");
    expect(deploy).toContain("30 5 1 * * /path/to/verder/ops/mail-restore-drill.sh");
    // And the deploy guide is what actually installs it.
    expect(deploy).toContain("8.12");
  });

  /*
   * THE FAILURE PATH IS THE POINT OF A DRILL. Every exit before the assertions —
   * no archive, an archive that will not extract, an extracted tree with no
   * etc/config.json, a scratch server that never came up — used to record
   * NOTHING: the dashboard's `DISTINCT ON (worker)` kept showing last month's
   * `ok`, and the monthly rule called the backup healthy for another 35 days. So
   * "this archive cannot restore" was the one outcome that reached no surface at
   * all.
   */
  it("records a worker_runs row for the failures it detects itself", () => {
    expect(code).toMatch(/drill_fail\(\)/);
    expect(code).toMatch(/MAIL_DRILL_SHELL_FAILURE="\$1"/);
    expect(code).toMatch(/-e MAIL_DRILL_SHELL_FAILURE/);
    // Every early exit goes through it. A bare `exit 1` outside drill_fail is
    // the regression this asserts against — the two legal ones are the lock
    // refusal (the drill holding the lock writes the row) and drill_fail's own.
    const bareExits = code.split("\n")
      .filter((l) => /^\s*exit 1\s*$/.test(l)).length;
    expect(bareExits).toBe(2);
    for (const reason of [
      "no native-\\*\\.tar\\.zst in \\$OUT",
      "could not be decompressed and extracted",
      "extracted WITHOUT a non-empty etc/config\\.json",
      "is missing \\$d/",
      "did not start at all",
      "never became healthy",
    ]) {
      expect(code).toMatch(new RegExp(`drill_fail "[^"]*${reason}`));
    }
  });

  /*
   * THE STEP MOST LIKELY TO HANG, and it was the one step with no bound. It
   * talks JMAP to a RocksDB store just opened cold from a month-old tar, and
   * there is NO request timeout on that path — jmap-client.ts passes no
   * AbortSignal and undici's body timeout resets per chunk. Unbounded, the
   * monthly cron hangs with the scratch server up and ~20 GB held, and the EXIT
   * trap is never reached. A killed run also writes no row, so the shell writes
   * one.
   */
  it("bounds the assertion run and records a row when it has to kill it", () => {
    expect(code).toMatch(/MAIL_DRILL_TS_TIMEOUT:-\d+/);
    expect(code).toMatch(/timeout "\$DRILL_TIMEOUT" "\$\{COMPOSE\[@\]\}" run --rm -T --no-deps/);
    expect(code).toMatch(/DRILL_RC" -eq 124/);
    expect(code).toMatch(/DRILL_RC" -eq 137/);
  });

  /*
   * The first argument may be an ABSOLUTE PATH — that is how a human drills an
   * archive from somewhere else — and for such a file the sidecar sits beside
   * IT, not in $OUT. $OUT is what gets bind-mounted as /mail-backups, so
   * `/mail-backups/<basename>` would resolve a DIFFERENT archive's manifest if
   * one shares the name; readFileSync succeeds, so the drill would be judged
   * against the wrong baseline with no loud fallback anywhere.
   */
  it("refuses a manifest that is not in the directory it mounts", () => {
    expect(code).toMatch(/\[ "\$\(dirname "\$MANIFEST_HOST"\)" != "\$OUT" \]/);
    expect(code).toMatch(/is outside \$OUT/);
  });
});

describe("mail-drill.compose.yml", () => {
  /*
   * ============ THE MOST DANGEROUS LINE IN THE WHOLE TASK ============
   * The JMAP session's apiUrl / downloadUrl / uploadUrl are built from the
   * CONFIGURED public url, verbatim, and never from the request that asked for
   * the session. Inherit production's http://stalwart:8080 and the RESTORED
   * server hands back apiUrl http://stalwart:8080/jmap/ — so the drill
   * authenticates against the scratch container, then sends every method call to
   * PRODUCTION, compares production with production, and reports that the backup
   * restored perfectly. There is no symptom: the counts match because it is the
   * same server.
   */
  it("gives the scratch server its OWN public url", () => {
    expect(ymlCode).toMatch(/STALWART_PUBLIC_URL=http:\/\/stalwart-drill:8080/);
    expect(ymlCode).not.toMatch(/STALWART_PUBLIC_URL=http:\/\/stalwart:8080/);
    // The node-id lease keys on hostname, so the two must not look like one node.
    expect(ymlCode).toMatch(/STALWART_HOSTNAME=stalwart-drill/);
    expect(ymlCode).not.toMatch(/STALWART_HOSTNAME=stalwart\s*$/m);
  });

  /*
   * Compose interpolates the WHOLE rendered file on EVERY command, for every
   * service, before it looks at which service you named. A `:?` here would abort
   * ops/nightly.sh (03:30, `set -euo pipefail`) at its first pg_dump, leaving a
   * zero-byte backup and skipping nightly-verify — measured, and documented at
   * length in docker-compose.prod.yml.
   */
  it("uses no ${VAR:?} anywhere", () => {
    expect(ymlCode).not.toMatch(/\$\{[A-Za-z_][A-Za-z0-9_]*:\?/);
  });

  /*
   * Without create_host_path:false a typo'd or unset scratch path is silently
   * CREATED as an empty root-owned directory; Stalwart finds no config.json,
   * bootstraps on an empty store, and the drill "restores" nothing while
   * reporting an empty mailbox. With it, the typo cannot start.
   */
  it("refuses to create its own bind sources", () => {
    const flags = ymlCode.match(/create_host_path:\s*false/g) ?? [];
    expect(flags).toHaveLength(3);
  });

  /*
   * The drill client runs inside the compose network and reaches the service by
   * name. Publishing a port would put a SECOND mail server on the host's
   * loopback serving a month-old copy of the whole dossier — for the duration of
   * the drill, and for as long afterwards as anyone forgets to remove it.
   */
  it("publishes no ports at all", () => {
    expect(ymlCode).not.toMatch(/^\s*ports:/m);
    expect(ymlCode).not.toMatch(/127\.0\.0\.1:\d+:\d+/);
  });

  /*
   * The drill deletes the store this container reads. `unless-stopped` would
   * restart it into a directory that no longer exists, on every boot, forever.
   */
  it("never restarts on its own", () => {
    expect(ymlCode).toMatch(/restart:\s*"no"/);
    expect(ymlCode).not.toMatch(/unless-stopped/);
  });

  /*
   * Tier 1 is a native RocksDB snapshot, so what the drill proves is that THIS
   * Stalwart version opens THAT store. `:latest` would test a version we do not
   * run — and would quietly test a different question every month.
   */
  it("pins the same image tag production runs", () => {
    const prod = readFileSync(new URL("../../../../docker-compose.prod.yml", import.meta.url), "utf8");
    const tag = prod.match(/image:\s*(stalwartlabs\/stalwart:[^\s]+)/)?.[1];
    expect(tag).toBeTruthy();
    expect(ymlCode).toContain(`image: ${tag}`);
    expect(ymlCode).not.toMatch(/stalwart:latest/);
  });

  /*
   * One service. An overlay that redefined `stalwart`, `worker` or `postgres`
   * would silently change production the moment the drill's file set is used —
   * and the drill's file set is used for `up -d` and for the cleanup.
   */
  it("adds exactly one service and redefines none of production's", () => {
    const services = [...ymlCode.matchAll(/^ {2}([a-z0-9-]+):$/gm)].map((m) => m[1]);
    expect(services).toEqual(["stalwart-drill"]);
  });

  /*
   * The scratch paths must share nothing with the live store, even in the
   * defaults nobody expects to be used — the defaults are what a hand-run
   * `up -d stalwart-drill` with an empty environment would aim at.
   */
  it("defaults its binds to the drill scratch root, never the live store", () => {
    expect(ymlCode).not.toMatch(/\/mnt\/data\/verder\/stalwart\//);
    for (const d of ["etc", "data", "blobs"]) {
      expect(ymlCode).toContain(`/mnt/data/verder/mail-drill-tmp/store/${d}`);
    }
  });
});

describe("worker package.json", () => {
  it("exposes the drill under the name the shell invokes", () => {
    expect(pkg.scripts["mail-drill"]).toBe("tsx src/ops/mail-restore-drill.ts");
  });
});

/*
 * THE ONE TEST IN THIS FILE THAT IS NOT A GREP.
 *
 * Everything above reads the script as text and can only prove that a line is
 * present. This block EXECUTES the real `tier2_parse_count` — extracted from the
 * script itself, so it tests whatever that function says today rather than a
 * copy — against the output `vandelay inspect` ACTUALLY PRODUCED on the homelab
 * on 2026-09-01, captured verbatim below.
 *
 * It matters because that parser was written blind: at the time nobody in this
 * project had ever run `inspect`, and CLAUDE.md's whole discipline is to keep
 * read-from-source and measured-against-a-running-thing apart. The measurement
 * turned up a separator (`146,270`) that a plain [0-9]+ would have read as 146
 * — the survival archive reported as holding 146 of 146,270 messages, every
 * month, in the one worker whose errors deliberately never age out.
 */
const INSPECT_OUTPUT_2026_09_01 = [
  "Archive: /mnt/data/verder/mail-drill-probe/archive.sqlite",
  "Source:  jmap http://stalwart:8080 (account c / martin@vanderpoel.pro)",
  "",
  "  mailbox                   21",
  "  email                146,270",
  "  identity                   1",
  "  sievescript                0",
  "  addressbook                1",
  "  contactcard                0",
  "  calendar                   1",
  "  calendarevent              0",
  "  participantidentity        1",
  "  filenode                   0",
  "",
  "  blobs                146,270  (11.5 GB)",
  "",
].join("\n");

/** Run the script's OWN tier2_parse_count over `input`, nothing copied. */
function parseWithTheRealFunction(input: string): string {
  const fn = /^tier2_parse_count\(\) \{\n[\s\S]*?^\}$/m.exec(sh);
  if (!fn) throw new Error("tier2_parse_count() not found in ops/mail-restore-drill.sh");
  return execFileSync("bash", ["-c", `${fn[0]}\ntier2_parse_count`], {
    input, encoding: "utf8",
  }).trim();
}

describe("tier2_parse_count against real vandelay inspect output", () => {
  it("reads 146270 from the output measured on the homelab, separator and all", () => {
    expect(parseWithTheRealFunction(INSPECT_OUTPUT_2026_09_01)).toBe("146270");
  });

  /*
   * The failure this guards is quiet, not loud: `mailbox 21` sits one line ABOVE
   * `email`, so a pattern loosened to /mail/ takes 21 and the drill reports the
   * survival archive holding 21 messages. Both wrong answers are plausible
   * numbers, which is exactly why they need pinning.
   */
  it("takes the email line and never the mailbox line above it", () => {
    expect(parseWithTheRealFunction(INSPECT_OUTPUT_2026_09_01)).not.toBe("21");
  });

  it("returns nothing for output with no email count, so the caller reports a skip", () => {
    expect(parseWithTheRealFunction("Archive: x\n\n  mailbox  21\n  filenode  0\n")).toBe("");
  });

  /*
   * A vandelay that dies prints an error, not a table. That must be a SKIP
   * carrying the message — never a count, and never a silent zero, which the
   * drill would compare against 146,270 and report as a catastrophic loss.
   */
  it("returns nothing for an error message rather than inventing a count", () => {
    expect(parseWithTheRealFunction("Error: unable to open database file\n")).toBe("");
  });
});
