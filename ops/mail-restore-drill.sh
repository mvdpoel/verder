#!/usr/bin/env bash
# Monthly restore drill for the Stalwart mail store — the other half of
# ops/mail-backup.sh.
#
# WHAT THIS IS FOR. mail-backup.sh already refuses to trust an exit code: it
# reads its own archive back and requires etc/config.json to be in it. That
# proves the TAR is well formed. It cannot prove that the bytes inside it are a
# store this Stalwart will open, that the directory inside them still
# authenticates the app password, or that the 146 270 messages are all there.
# The only thing that proves a backup restores is a restore. This script
# performs one, every month, against a scratch server, and throws it away.
#
# WHAT IT DELIBERATELY IS NOT. It never touches production's store, container or
# port. It reads two files from the NAS, extracts them into a scratch directory
# on /mnt/data, starts ONE extra container, asks it questions, and removes both.
# The only production service it uses is the `worker` image, and only to run the
# assertions from inside the compose network.
#
# THE PLAN'S VERSION OF THIS TASK WAS ENTIRELY MOCKED — a pure boolean over fake
# dependencies, with no main(), no restore and no scratch server. That is a green
# test over an unexercised backup, which is the same class of thing as an archive
# with a plausible name and no etc/ in it. This is the replacement.
#
# Run by hand, or monthly from cron (the crontab is CRON_TZ=UTC):
#   30 5 1 * * /home/homelab/apps/verder/ops/mail-restore-drill.sh >> /home/homelab/apps/verder/nightly.log 2>&1
# It shares nightly.log because that name is in the rsync exclude list and a new
# one would not be: `--delete` erases an unexcluded log on the next deploy.
# THAT LINE IS SPELLED IN THREE PLACES — here, in docs/deploy.md §8.12 (which is
# what actually installs it) and in packages/api/src/worker-health.ts, whose
# 35-day staleness bound is reasoned FROM it. They must move together: nothing in
# this repo installs the crontab, so this comment is what an operator copies, and
# the dashboard cannot warn about a drill that has never run — routers/
# dashboard.ts lists the workers that HAVE a `worker_runs` row, so a drill nobody
# scheduled has no tile at all rather than a red one.
# Optional first argument: the archive to drill, so a human can reach for the
# second-newest when the newest is the one under suspicion. That fallback is
# precisely what mail-backup.sh's five-week tier-2 retention promises.
set -euo pipefail
cd "$(dirname "$0")/.."

# Cron starts with a near-empty environment; everything comes from .env.prod,
# the same way nightly.sh and mail-backup.sh do it.
set -a
# shellcheck disable=SC1091
source ./.env.prod
set +a

# TWO compose invocations, and the difference is load-bearing.
#
# COMPOSE is production alone. It is what runs the worker for the assertions.
# DRILL is production PLUS the overlay, which is the only way `stalwart-drill`
# exists at all and the only way it joins `verder_default` so the worker can
# resolve it by name.
#
# ============================ THE OVERLAY TRAP ============================
# With BOTH files on the command line, `docker compose ... down` means DOWN THE
# WHOLE PROJECT: postgres, web, worker and the production stalwart. The drill
# would end by taking the dossier offline, and the cron log would show a
# successful drill. So:
#   * cleanup is `rm -sf stalwart-drill` — a service name, always.
#   * never `down`, with or without the overlay.
#   * never `stop` without a service name.
#   * never `--remove-orphans`: run against the overlay pair it reaps nothing,
#     but run against production alone afterwards it would reap the drill
#     container, and run against the overlay while a service is temporarily
#     absent from a file it reaps production's.
# ==========================================================================
COMPOSE=(docker compose --env-file .env.prod -f docker-compose.prod.yml)
DRILL=(docker compose --env-file .env.prod -f docker-compose.prod.yml -f ops/mail-drill.compose.yml)

OUT="${BACKUP_DIR:-/mnt/nas/verder-backups}/mail"
VANDELAY="${VANDELAY_BIN:-/mnt/data/verder/mail-import/vandelay-x86_64-unknown-linux-musl/vandelay}"

# Named as early as possible so `drill_fail` can always report WHICH archive was
# being drilled, including on the paths that die before one is chosen.
export MAIL_DRILL_ARCHIVE=""

# ---------------------------------------------------------------------------
# THE FAILURE PATH, and it is not decoration.
# ---------------------------------------------------------------------------
# Every `exit 1` in this script before step 7 used to be SILENT to every
# monitoring surface there is. "There is no archive to restore from", "the tar
# extracted without etc/config.json", "the snapshot did not open in 300 s" —
# those are not preliminaries to the drill, they ARE the drill's result, and each
# of them wrote no `worker_runs` row and sent no push. The dashboard reads
# `SELECT DISTINCT ON (worker) … ORDER BY ran_at DESC`, so the newest row stays
# LAST month's `ok` and the monthly rule keeps calling the backup healthy for
# another 35 days. The single most important thing a restore drill can say would
# have lived in the cron log and nowhere else.
#
# The row is written by the TS half rather than here, through
# MAIL_DRILL_SHELL_FAILURE: one row format, one push, one place that knows the
# worker's name. If that recording itself fails there is nothing left to do but
# say so on stderr — but it is bounded (`timeout`), because a drill that hangs
# while reporting a failure is the failure it was reporting plus a stuck cron.
#
# ITS EXIT CODE ANSWERS "DID YOU RECORD IT?", NOT "DID THE DRILL PASS?" — the
# drill has already failed by the time we are here, and this script's own
# `exit 1` below is what says so. MEASURED 2026-09-01 against a deliberately
# truncated snapshot: the first version had the TS half exit 1 after recording
# perfectly, so this `if !` fired and the cron log claimed the row could not be
# written while the row sat in the database saying exactly the right thing. The
# warning below is only worth printing if it is TRUE, because it is read on the
# one night the operator most needs to trust what they are told.
drill_fail() {
  echo "mail-restore-drill.sh: $1" >&2
  if ! MAIL_DRILL_SHELL_FAILURE="$1" timeout 120 "${COMPOSE[@]}" run --rm -T --no-deps \
      -e MAIL_DRILL_SHELL_FAILURE \
      -e MAIL_DRILL_ARCHIVE \
      worker pnpm --filter worker mail-drill; then
    echo "mail-restore-drill.sh: AND the mail-drill failure row could not be recorded —" >&2
    echo "mail-restore-drill.sh: the dashboard tile still shows the PREVIOUS run. This" >&2
    echo "mail-restore-drill.sh: cron log is the only record that the drill failed." >&2
  fi
  exit 1
}

# Scratch root. NOT /tmp, for the reason mail-backup.sh records: /tmp is on `/`
# with ~40 GB free, the extracted store is ~7.3 GB and the decompressed weekly
# archive another ~12.5 GB. Filling root on the machine that holds the ledger is
# a worse outcome than a missed drill. /mnt/data has ~340 GB free.
SCRATCH_ROOT="${MAIL_DRILL_SCRATCH:-/mnt/data/verder/mail-drill-tmp}"

# The production store, named here ONLY so the guard below can refuse to point
# the drill at it. Defaulted exactly as docker-compose.prod.yml and
# mail-backup.sh default them — three copies that must move together.
PROD_ETC="${STALWART_ETC_DIR:-/mnt/data/verder/stalwart/etc}"
PROD_DATA="${STALWART_DATA_DIR:-/mnt/data/verder/stalwart/data}"
PROD_BLOB="${STALWART_BLOB_DIR:-/mnt/data/verder/stalwart/blobs}"
PROD_ROOT=$(dirname "$PROD_DATA")

# THE GUARD THAT MAKES EVERY `rm -rf` BELOW SAFE TO READ. This script extracts
# over its scratch root and deletes it afterwards. If MAIL_DRILL_SCRATCH ever
# names production's store — a fat-fingered export, a copied line — the drill
# would restore a month-old snapshot OVER the live mail store and then delete
# it. Refuse before anything is created.
#
# `dirname "$PROD_ROOT"` (/mnt/data/verder) is in the list for a reason that is
# not obvious: it is the parent of the live store AND of both scratch roots this
# repo uses, which makes it the plausible fat-finger. Naming it there would make
# the `sudo chown` below hand ownership of the directory holding the mail store
# to the cron user. Only the directory ITSELF is refused, not everything under
# it — the default scratch root lives under it and must stay legal.
case "$SCRATCH_ROOT" in
  "$PROD_ROOT" | "$PROD_ROOT"/* | "$PROD_ETC" | "$PROD_DATA" | "$PROD_BLOB" \
    | "$(dirname "$PROD_ROOT")" | / | /mnt | /mnt/data)
    drill_fail "MAIL_DRILL_SCRATCH ($SCRATCH_ROOT) is inside the live mail store \
($PROD_ROOT) or is a shared root — refusing to drill"
    ;;
esac

# Minimal JSON string escaping, for the tier-2 payload below. Control characters
# are flattened rather than escaped: the only strings that reach it are a file
# name and a vandelay error line, and a drill must never fail because a stray
# tab in someone else's output made its own JSON unparseable.
# The email count out of `vandelay inspect`, read from stdin. A FUNCTION rather
# than an inline pipeline for one reason: apps/worker/src/ops/mail-restore-drill-script.test.ts
# extracts this exact block and runs it against the real output captured below,
# so the regression test exercises whatever this regex says TODAY rather than a
# copy of it that drifts the first time somebody tunes it.
#
# MEASURED 2026-09-01 against the real weekly archive on the homelab. It was
# written blind — nobody had ever run `inspect` — and the measurement is why the
# separator handling below is not decoration:
#
#   Archive: /mnt/data/verder/.../archive.sqlite
#   Source:  jmap http://stalwart:8080 (account c / martin@vanderpoel.pro)
#
#     mailbox                   21
#     email                146,270      <- THOUSANDS SEPARATOR
#     identity                   1
#     ...
#     blobs                146,270  (11.5 GB)
#
# Three traps that output carries, all live:
#   1. The count is comma-grouped. A plain [0-9]+ reads `146` and the drill then
#      reports the survival archive holding 146 of 146,270 messages — a false
#      alarm every month, in the one worker whose errors deliberately never age
#      out (packages/api/src/worker-health.ts).
#   2. `mailbox 21` sits ABOVE `email` and `blobs 146,270` below it. The pattern
#      requires `e-?mails?`, so "mailbox" cannot match it — but a looser /mail/
#      would take 21 and be wrong in the quiet direction, which is worse.
#   3. `head -1` twice, so the answer is the FIRST email-ish count and never a
#      concatenation of several.
# A parse MISS is reported as a skip carrying the first line of the real output
# — never as a count, and never as a failure of the backup itself.
tier2_parse_count() {
  grep -oiE '([0-9][0-9,._ ]*[0-9]|[0-9])[[:space:]]*e-?mails?|e-?mails?[^0-9]{0,24}([0-9][0-9,._ ]*[0-9]|[0-9])' \
    | head -1 \
    | grep -oE '[0-9][0-9,._ ]*[0-9]|[0-9]' \
    | head -1 \
    | tr -d ',._ '
}

json_string() {
  printf '%s' "$1" \
    | LC_ALL=C tr '\n\r\t' '   ' \
    | LC_ALL=C tr -d '\000-\037' \
    | LC_ALL=C sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# ---------------------------------------------------------------------------
# 1. Pick the archive.
# ---------------------------------------------------------------------------
if [ "$#" -gt 0 ] && [ -n "${1:-}" ]; then
  # A bare name resolves inside $OUT, a path is taken as given — a human
  # reaching for yesterday's archive types the name they see in `ls`.
  if [ -f "$1" ]; then ARCHIVE="$1"; else ARCHIVE="$OUT/$1"; fi
  [ -f "$ARCHIVE" ] || drill_fail "no such archive: $1"
else
  # Newest by MTIME, not by the date in the name: a re-run, a copy or a restored
  # NAS all put a name and a timestamp out of step, and the timestamp is the one
  # that says which file was actually written last.
  ARCHIVE=$(find "$OUT" -maxdepth 1 -type f -name 'native-*.tar.zst' -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | head -1 | cut -d' ' -f2-)
  if [ -z "$ARCHIVE" ]; then
    # The loudest possible failure, on purpose: a silent skip here is
    # indistinguishable from a month of green drills.
    drill_fail "no native-*.tar.zst in $OUT — there is NOTHING to restore from"
  fi
fi
ARCHIVE_NAME=$(basename "$ARCHIVE")
export MAIL_DRILL_ARCHIVE="$ARCHIVE_NAME"
echo "mail-restore-drill.sh: drilling $ARCHIVE_NAME"

# ---------------------------------------------------------------------------
# 2. Scratch directory, self-healing.
# ---------------------------------------------------------------------------
# /mnt/data/verder is root-owned 0755, so the cron user cannot mkdir inside it —
# measured while building mail-backup.sh, and only AFTER its first tier had
# already succeeded. A script that needs a manual mkdir before it works does half
# its job in silence on a rebuilt machine, and a rebuilt machine is exactly the
# machine a RESTORE DRILL is for. sudo creates it, then hands it to the caller so
# everything below runs unprivileged.
if [ ! -d "$SCRATCH_ROOT" ]; then
  sudo mkdir -p "$SCRATCH_ROOT"
  sudo chown "$(id -u):$(id -g)" "$SCRATCH_ROOT"
fi

# ONE DRILL AT A TIME, and the design invites two: the header documents a human
# running this by hand against the second-newest archive, which is exactly the
# situation where the newest is under suspicion and somebody is also watching the
# schedule. Each run gets its own mktemp tree but they share ONE compose service
# name, so a second `up -d stalwart-drill` RECREATES the container onto its own
# store — killing the first drill's server mid-probe — and the first drill's trap
# then `rm -sf`s the second's container. Both then report failures that say
# nothing about any backup.
#
# `-n`, so the second run REFUSES rather than queueing behind a drill that holds
# the lock for half an hour. It refuses BEFORE the cleanup trap is installed and
# before any directory is created, so it cannot delete the running drill's
# anything — and it does NOT record a worker_runs row: the drill that holds the
# lock is going to write one, and a refusal row would replace a real verdict with
# "somebody ran it twice".
#
# Guarded on `flock` existing at all. It is util-linux and present on this host,
# but a missing lock must degrade to the old unlocked behaviour rather than
# refusing to drill at all — a missed drill is worse than a race that has never
# happened.
LOCK="$SCRATCH_ROOT/.drill.lock"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK"
  if ! flock -n 9; then
    echo "mail-restore-drill.sh: another drill holds $LOCK — refusing to start a second" >&2
    echo "mail-restore-drill.sh: one. They share the stalwart-drill service name and would" >&2
    echo "mail-restore-drill.sh: destroy each other's container." >&2
    exit 1
  fi
else
  echo "mail-restore-drill.sh: flock not found; running WITHOUT the single-drill lock" >&2
fi

SCRATCH=$(mktemp -d "$SCRATCH_ROOT/run-XXXXXX")
STORE="$SCRATCH/store"
mkdir -p "$STORE"

# ---------------------------------------------------------------------------
# The cleanup trap. It runs on EVERY exit path, including the failures.
# ---------------------------------------------------------------------------
# WHAT IT IS ALLOWED TO DELETE, exhaustively:
#   * the container/service `stalwart-drill` (compose `rm -sf`, never `down`)
#   * the directory $SCRATCH, which is a mktemp run-XXXXXX under $SCRATCH_ROOT
# WHAT IT MUST NEVER TOUCH:
#   * /mnt/data/verder/stalwart/{etc,data,blobs} — the live store
#   * the `stalwart` service or 127.0.0.1:8080 — the live server
#   * $BACKUP_DIR/mail/* — the backups themselves. This script only ever READS
#     them; the NAS is bind-mounted read-only into the worker for the same
#     reason.
cleanup() {
  rc=$?
  # Service name, always. See THE OVERLAY TRAP above.
  #
  # AND VERIFIED, for the same reason the scratch tree below is — and this is the
  # half with production blast radius. `rm -sf` renders BOTH compose files, so it
  # fails whenever the merged config fails to render (a `${VAR:?}` somebody adds
  # to docker-compose.prod.yml, an .env.prod mid-edit, a renamed overlay) or the
  # daemon returns a transient error. Discarding its exit code left a FULL SECOND
  # STALWART on `verder_default`, serving a month-old copy of the whole dossier,
  # with its etc/data/blobs deleted out from under it — open FDs keep it serving —
  # and the drill still printed PASS. `restart: "no"` bounds it to the next
  # reboot; nothing bounded it before that, and nothing said a word. It also
  # poisons the NEXT drill, whose `up -d` then has to recreate a container the
  # last run failed to remove.
  #
  # The verification does NOT go back through compose, deliberately: the case
  # that matters most is a compose invocation that cannot run, and asking the
  # broken tool whether it worked answers "nothing found" either way. Docker's
  # own labels are the fact.
  if ! rm_out=$("${DRILL[@]}" rm -sf stalwart-drill 2>&1); then
    echo "mail-restore-drill.sh: could not remove the stalwart-drill service: $rm_out" >&2
  fi
  leftover=$(docker ps -aq \
    --filter "label=com.docker.compose.service=stalwart-drill" 2>/dev/null) || leftover=""
  if [ -n "$leftover" ]; then
    echo "mail-restore-drill.sh: A SCRATCH STALWART IS STILL RUNNING ($leftover). It holds a" >&2
    echo "mail-restore-drill.sh: month-old copy of the whole dossier on the production" >&2
    echo "mail-restore-drill.sh: network. Remove it by hand:" >&2
    echo "mail-restore-drill.sh:   docker rm -f $leftover" >&2
    # `if` and not `[ … ] && rc=1`: under `set -e` a short-circuited `&&` list
    # is a failing statement, and a failing statement INSIDE THE EXIT TRAP ends
    # the trap early — here that would skip the scratch removal below and leave
    # 20 GB behind, on precisely the runs that already went wrong.
    if [ "$rc" -eq 0 ]; then rc=1; fi
  fi

  if [ -n "${SCRATCH:-}" ] && [ -e "$SCRATCH" ]; then
    # sudo, because tar restored the tree with the archive's uid/gid 2000 and the
    # cron user cannot remove it.
    #
    # NOTE THE FORM. `sudo rm -rf "$SCRATCH"/*` would SILENTLY DO NOTHING on the
    # extracted etc/: that directory is 0750 owned by uid 2000, so the glob is
    # expanded by the UNPRIVILEGED shell before sudo runs, matches nothing, and
    # rm exits 0 having removed nothing (docs/deploy.md §8 trap 5 — measured:
    # data/ and blobs/ were wiped and etc/config.json survived). Naming the
    # directory itself has no glob to expand in the wrong process.
    sudo rm -rf -- "$SCRATCH" || true
    # AND VERIFY, rather than trust the exit code — the same discipline
    # mail-backup.sh applies to tar. A leftover run directory is 20 GB of
    # /mnt/data that nothing will ever clean up, and the next drill would not
    # notice it.
    if [ -e "$SCRATCH" ]; then
      echo "mail-restore-drill.sh: FAILED to remove scratch dir $SCRATCH — it holds" >&2
      echo "mail-restore-drill.sh: ~20 GB and a full copy of the mail store. Remove it" >&2
      echo "mail-restore-drill.sh: by hand: sudo rm -rf -- '$SCRATCH'" >&2
      # `if` and not `[ … ] && rc=1`: under `set -e` a short-circuited `&&` list
    # is a failing statement, and a failing statement INSIDE THE EXIT TRAP ends
    # the trap early — here that would skip the scratch removal below and leave
    # 20 GB behind, on precisely the runs that already went wrong.
    if [ "$rc" -eq 0 ]; then rc=1; fi
    fi
  fi
  # `exit` inside an EXIT trap sets the final status and does not re-enter the
  # trap. Without it the drill's own exit code would still stand, but a failed
  # cleanup could not turn a green run red.
  exit "$rc"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 3. Extract, under sudo, and check what actually landed.
# ---------------------------------------------------------------------------
# sudo ON THE TAR so the archive's OWNERSHIP IS PRESERVED. The store is written
# by uid/gid 2000 (the image's unprivileged user) and the archive carries that.
# An unprivileged extract lands the whole tree owned by the cron user, the
# container cannot read its own database, and the drill fails looking like a
# Stalwart bug — an hour spent on the wrong question, every month.
#
# NOT LEFT TO `set -e`. A bare pipeline here would exit the script with the
# cleanup trap running and NOTHING recorded — and "the archive would not
# decompress" is the drill's headline result, not a preliminary to it. The
# failing exit code is captured so drill_fail can say so where somebody reads it.
# `pipefail` is on, so a zstd that dies mid-stream fails this too.
echo "mail-restore-drill.sh: extracting into $STORE"
if ! zstd -dc "$ARCHIVE" | sudo tar -C "$STORE" -xf -; then
  drill_fail "$ARCHIVE_NAME could not be decompressed and extracted — this archive \
cannot restore"
fi

# THE ACCEPTANCE TEST ON THE EXTRACTED REALITY, not on the archive's index.
# mail-backup.sh already requires etc/config.json to be a MEMBER at write time;
# this requires it to be a non-empty FILE on disk after extraction, which is a
# different claim (a truncated member, a partial extract, a full disk). Without
# it the server comes up in BOOTSTRAP MODE on an EMPTY store and offers to build
# a second one — and a drill against a bootstrapped empty store connects fine,
# counts zero mail, and reports "the backup is broken" when in truth nothing was
# ever restored.
if ! sudo test -s "$STORE/etc/config.json"; then
  drill_fail "$ARCHIVE_NAME extracted WITHOUT a non-empty etc/config.json — a server \
started on this tree would come up in BOOTSTRAP MODE on an empty store. This archive \
cannot restore."
fi
for d in etc data blobs; do
  if ! sudo test -d "$STORE/$d"; then
    drill_fail "$ARCHIVE_NAME is missing $d/ — incomplete archive, it cannot restore"
  fi
done

# ---------------------------------------------------------------------------
# 4. Start the scratch server as an overlay on the production project.
# ---------------------------------------------------------------------------
# Exported, not passed inline: compose interpolates the overlay's bind sources
# from the environment. The overlay's own defaults point at the scratch root and
# NEVER at production, but they cannot know about this run's mktemp directory,
# so all three are set here and the defaults exist only so a hand-run compose
# command still cannot aim at the live store.
export MAIL_DRILL_ETC_DIR="$STORE/etc"
export MAIL_DRILL_DATA_DIR="$STORE/data"
export MAIL_DRILL_BLOB_DIR="$STORE/blobs"

if ! "${DRILL[@]}" up -d stalwart-drill; then
  drill_fail "the scratch server could not be started on $ARCHIVE_NAME (docker compose \
up -d stalwart-drill failed)"
fi

# ---------------------------------------------------------------------------
# 5. Wait for health — BOUNDED.
# ---------------------------------------------------------------------------
# An unbounded wait in a cron job is a hang nobody sees: no output, no failure,
# no notification, and a 7 GB scratch tree left behind because the trap never
# runs. The bound is generous (RocksDB opens a 7 GB store cold) and finite.
HEALTH_TIMEOUT="${MAIL_DRILL_HEALTH_TIMEOUT:-300}"
CID=$("${DRILL[@]}" ps -q stalwart-drill) || CID=""
if [ -z "$CID" ]; then
  drill_fail "stalwart-drill did not start at all on $ARCHIVE_NAME"
fi
waited=0
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$CID" 2>/dev/null)" = "healthy" ]; do
  # A container that EXITED will never become healthy; failing now beats waiting
  # out the full timeout for a verdict already reached.
  if [ "$(docker inspect -f '{{.State.Running}}' "$CID" 2>/dev/null)" != "true" ]; then
    echo "mail-restore-drill.sh: stalwart-drill exited while starting. Its logs:" >&2
    docker logs --tail 80 "$CID" >&2 || true
    drill_fail "the scratch server EXITED while opening $ARCHIVE_NAME — the snapshot \
did not open (its logs are in the drill log)"
  fi
  if [ "$waited" -ge "$HEALTH_TIMEOUT" ]; then
    echo "mail-restore-drill.sh: Its logs:" >&2
    docker logs --tail 80 "$CID" >&2 || true
    drill_fail "the scratch server never became healthy in ${HEALTH_TIMEOUT}s on \
$ARCHIVE_NAME — this IS the drill result: the snapshot did not open"
  fi
  sleep 5
  waited=$((waited + 5))
done
echo "mail-restore-drill.sh: stalwart-drill healthy after ${waited}s"

# ---------------------------------------------------------------------------
# 6. Tier 2 — the weekly Vandelay archive. ALWAYS produces a value.
# ---------------------------------------------------------------------------
# The TS side treats a MISSING MAIL_DRILL_TIER2 as a failure, on purpose: the
# whole reason tier 2 exists is that tier 1 depends on a pre-1.0 on-disk format,
# so "we forgot to look" and "the survival copy is fine" must never render the
# same. Every path below therefore ends in JSON — a count, or a stated reason.
#
# Run AFTER the native restore, so a broken snapshot fails fast rather than
# after ten minutes of decompressing 12.5 GB nobody will get to use.
tier2_skip() { MAIL_DRILL_TIER2="{\"skipped\":\"$(json_string "$1")\"}"; }

TIER2_ARCHIVE=$(find "$OUT" -maxdepth 1 -type f -name 'archive-*.sqlite.zst' -printf '%T@ %p\n' 2>/dev/null \
  | sort -rn | head -1 | cut -d' ' -f2-)
TIER2_AGE=$(find "$OUT" -maxdepth 1 -type f -name 'archive-*.sqlite.zst.age' -printf '%T@ %p\n' 2>/dev/null \
  | sort -rn | head -1 | cut -d' ' -f2-)

if [ -z "$TIER2_ARCHIVE" ] && [ -n "$TIER2_AGE" ]; then
  # Encrypted, and this script has no key and must not acquire one: the age
  # identity deliberately does not live only on this machine. Reading it is a
  # deliberate human act, not something a monthly cron does unattended.
  tier2_skip "weekly archive is age-encrypted ($(basename "$TIER2_AGE")); this drill cannot decrypt it"
elif [ -z "$TIER2_ARCHIVE" ]; then
  tier2_skip "no archive-*.sqlite.zst in $OUT"
elif [ ! -x "$VANDELAY" ]; then
  tier2_skip "vandelay not executable at $VANDELAY"
else
  TIER2_NAME=$(basename "$TIER2_ARCHIVE")
  echo "mail-restore-drill.sh: inspecting $TIER2_NAME"
  # ~12.5 GB decompressed, into the scratch root and never /tmp; the trap
  # removes it with the rest of $SCRATCH.
  if ! zstd -dq -o "$SCRATCH/archive.sqlite" "$TIER2_ARCHIVE"; then
    tier2_skip "could not decompress $TIER2_NAME"
  else
    # `vandelay inspect <archive> [type] [--limit N]` is READ-ONLY — it is the
    # only one of vandelay's three subcommands that cannot write anywhere.
    #
    # `|| true`: a non-zero vandelay is itself a reportable outcome, and its
    # stderr is the message worth carrying — dying here under `set -e` would
    # throw that away and take the whole drill with it.
    inspect_out=$("$VANDELAY" inspect "$SCRATCH/archive.sqlite" 2>&1) || true
    tier2_count=$(printf '%s\n' "$inspect_out" | tier2_parse_count) || true
    if [ -z "${tier2_count:-}" ]; then
      tier2_skip "could not parse vandelay inspect output: $(printf '%s\n' "$inspect_out" | head -1)"
    else
      MAIL_DRILL_TIER2="{\"archive\":\"$(json_string "$TIER2_NAME")\",\"emails\":$tier2_count}"
    fi
    # Reclaim the 12.5 GB now rather than at the trap: the assertions below take
    # minutes and there is no reason to hold it through them.
    rm -f "$SCRATCH/archive.sqlite"
  fi
fi
export MAIL_DRILL_TIER2
echo "mail-restore-drill.sh: tier 2 -> $MAIL_DRILL_TIER2"

# ---------------------------------------------------------------------------
# 7. The assertions, from inside the compose network.
# ---------------------------------------------------------------------------
export MAIL_DRILL_BASE_URL="http://stalwart-drill:8080"
export MAIL_DRILL_ARCHIVE="$ARCHIVE_NAME"
export MAIL_DRILL_SAMPLES="${MAIL_DRILL_SAMPLES:-8}"

# The manifest sidecar written beside the archive at snapshot time
# ({"count":N,"takenAt":"…","mailboxes":{name:total}}). It is the only record of
# what the store held WHEN THE SNAPSHOT WAS TAKEN, which is the number a restore
# should be compared against — production has moved on since.
#
# THE MOUNT IS NOT OPTIONAL FOR IT TO BE READABLE. The worker service mounts
# /vault, /scans and /repo/secrets and NOTHING else; $BACKUP_DIR is on the NAS
# and is invisible inside the container. So the backup directory is bind-mounted
# for this one run, READ-ONLY — the drill reads backups and must never be able to
# write one — and MAIL_DRILL_MANIFEST names the path as the CONTAINER sees it.
#
# THE NAME IS mail-backup.sh's, NOT ONE INVENTED HERE: that script writes
# `$OUT/native-$STAMP.json` beside `$OUT/native-$STAMP.tar.zst`. The two spell
# the same convention in two files, so the test pins this derivation against
# mail-backup.sh's own line — rename it there and the drill would silently fall
# back to the live count every month, which is the weaker comparison and looks
# exactly like a night the manifest could not be taken.
#
# AND IT MUST LIVE UNDER $OUT, because $OUT is what gets bind-mounted as
# /mail-backups. The first argument may be an ABSOLUTE PATH — that is deliberate,
# it is how a human drills an archive from somewhere else — and for such a file
# the sidecar sits beside IT, not in $OUT. Handing the container
# `/mail-backups/<basename>` would then resolve a DIFFERENT archive's manifest if
# one happens to share the name, and `readFileSync` succeeds, so the drill would
# be judged against the wrong baseline with no loud fallback anywhere. Refusing
# the manifest costs the weaker live comparison and says so.
MANIFEST_HOST="${ARCHIVE%.tar.zst}.json"
if [ -f "$MANIFEST_HOST" ] && [ "$(dirname "$MANIFEST_HOST")" != "$OUT" ]; then
  echo "mail-restore-drill.sh: $MANIFEST_HOST is outside $OUT, which is the only" >&2
  echo "mail-restore-drill.sh: directory mounted into the container — ignoring it and" >&2
  echo "mail-restore-drill.sh: comparing against the LIVE store instead." >&2
  export MAIL_DRILL_MANIFEST=""
elif [ -f "$MANIFEST_HOST" ]; then
  export MAIL_DRILL_MANIFEST="/mail-backups/$(basename "$MANIFEST_HOST")"
else
  # Empty rather than unset, and the TS side treats both as absent: a manifest is
  # a nice-to-have (the drill still compares the restore against LIVE production),
  # so its absence must not read as a broken drill.
  export MAIL_DRILL_MANIFEST=""
fi

# `-e NAME` passes the value from THIS environment; `-e NAME=value` would put it
# in the process table for every user on the box — the reason mail-backup.sh
# passes VANDELAY_PASSWORD by name. Nothing here is secret, but the habit is what
# keeps the one that is out of `ps`.
#
# JMAP_USER / JMAP_APP_PASSWORD / JMAP_BASE_URL are NOT passed: the worker
# service has `env_file: .env.prod`, so they are already in the container. The
# credentials are deliberately the SAME ones production uses — the restore is a
# byte copy, so the directory and the app password come back with it, and that
# the restored server ACCEPTS them is one of the things being proven.
#
# --no-deps: postgres is already up for the real worker, and this must not start
# anything as a side effect. --rm -T: one-shot, no TTY, cron-safe.
#
# BOUNDED, for the same reason step 5 is and mail-backup.sh's count is. This is
# the step MOST likely to hang: it talks JMAP to a RocksDB store that has just
# been opened cold from a month-old tar, and there is NO request timeout anywhere
# on that path — jmap-client.ts passes no AbortSignal, undici's defaults are all
# that sit under it, and its body timeout resets per chunk, so a trickling server
# hangs forever. Unbounded, the monthly cron would hang with the scratch Stalwart
# up and ~20 GB of /mnt/data held, and the EXIT trap never reached.
#
# 30 minutes is generous: the measured work is eight small queries and eight
# ~50 KB downloads against a server that is already healthy. `timeout` kills the
# compose CLI, which may leave the one-shot worker container behind — a bounded,
# visible mess, and strictly better than an unbounded hang holding the store.
DRILL_TIMEOUT="${MAIL_DRILL_TS_TIMEOUT:-1800}"
set +e
timeout "$DRILL_TIMEOUT" "${COMPOSE[@]}" run --rm -T --no-deps \
  -e MAIL_DRILL_BASE_URL \
  -e MAIL_DRILL_ARCHIVE \
  -e MAIL_DRILL_MANIFEST \
  -e MAIL_DRILL_TIER2 \
  -e MAIL_DRILL_SAMPLES \
  -v "$OUT:/mail-backups:ro" \
  worker pnpm --filter worker mail-drill
DRILL_RC=$?
set -e

# A KILLED ASSERTION RUN WROTE NO ROW, so the shell has to. `timeout` reports 124
# when it fired and 137 when the process needed SIGKILL; in both cases the TS
# half died mid-flight and `worker_runs` still holds last month's verdict, which
# is the exact silence drill_fail exists for. Every OTHER non-zero code is a
# JUDGED failure — the TS half wrote its own row and sent its own push — and must
# not be overwritten with a vaguer one from out here.
if [ "$DRILL_RC" -eq 124 ] || [ "$DRILL_RC" -eq 137 ]; then
  drill_fail "the drill's assertions were still running after ${DRILL_TIMEOUT}s on \
$ARCHIVE_NAME and were killed — the restored server never finished answering"
fi

# ---------------------------------------------------------------------------
# 8. One line, and the TS exit code.
# ---------------------------------------------------------------------------
# The detail lives in worker_runs (one `mail-drill` row) and, on failure, in a
# push notification. This line is for the cron log.
if [ "$DRILL_RC" -eq 0 ]; then
  echo "mail-restore-drill.sh: PASS ($ARCHIVE_NAME, tier2 $MAIL_DRILL_TIER2)"
else
  echo "mail-restore-drill.sh: FAIL rc=$DRILL_RC ($ARCHIVE_NAME) — see the mail-drill row" >&2
fi
exit "$DRILL_RC"
