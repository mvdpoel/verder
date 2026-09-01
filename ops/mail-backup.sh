#!/usr/bin/env bash
# Mail backup, in two formats on purpose — see the spec, section 2: never a
# generation where only the native form exists.
#
# Called from ops/nightly.sh (03:30 cron). It is LAST in that script on purpose:
# it is by far the longest step, it stops a service, and everything ahead of it
# is cheap integrity work that must not be skipped because a 7 GB tar failed.
#
# WHAT THE PLAN GOT WRONG, all three measured on the homelab before this was
# written, because each would have produced a backup that looks fine and cannot
# restore:
#
#   1. `vandelay export --format maildir` DOES NOT EXIST. Vandelay's model is
#      `import <source> -> local SQLite archive` and `export archive -> a JMAP
#      SERVER`. `vandelay --help` lists exactly three commands and `export
#      --help` takes --url/--auth-basic/--account-*, with no output format at
#      all. So the neutral tier here is a Vandelay ARCHIVE, not Maildir, and
#      that is a weaker guarantee than the spec asked for — see tier 2.
#   2. Backing up only $STALWART_DATA_DIR LOSES /etc/stalwart/config.json,
#      which 0.16 writes itself at the end of the setup wizard. Restore without
#      it and the server comes up in BOOTSTRAP MODE offering to build a second
#      store beside the good one — a restore that appears to work and serves an
#      empty mailbox. All three bind mounts are backed up here.
#   3. `${STALWART_DATA_DIR:?}` would abort every night. The variables are
#      genuinely absent from .env.prod: docker-compose.prod.yml defaults them
#      and documents that a `:?` anywhere near this service is a trap. The
#      defaults below are therefore COPIES OF THE COMPOSE DEFAULTS and must be
#      changed with them, or this script faithfully backs up the wrong path.
set -euo pipefail
cd "$(dirname "$0")/.."

set -a
# shellcheck disable=SC1091
source ./.env.prod
set +a

COMPOSE=(docker compose --env-file .env.prod -f docker-compose.prod.yml)
STAMP=$(date +%F)
WEEK=$(date +%G-W%V)
OUT="${BACKUP_DIR:-/mnt/nas/verder-backups}/mail"

# The three bind mounts, defaulted EXACTLY as docker-compose.prod.yml defaults
# them. etc/ is 8 KB and is the difference between a restore and a bootstrap.
ETC_DIR="${STALWART_ETC_DIR:-/mnt/data/verder/stalwart/etc}"
DATA_DIR="${STALWART_DATA_DIR:-/mnt/data/verder/stalwart/data}"
BLOB_DIR="${STALWART_BLOB_DIR:-/mnt/data/verder/stalwart/blobs}"
STORE_ROOT=$(dirname "$DATA_DIR")

# Scratch for the weekly pull. NOT mktemp's default: /tmp is on `/`, which has
# ~40 GB free, and the archive is ~12.5 GB before compression. Filling root on
# the machine that holds the ledger is a worse outcome than no backup.
SCRATCH_ROOT="${MAIL_BACKUP_SCRATCH:-/mnt/data/verder/mail-backup-tmp}"
VANDELAY="${VANDELAY_BIN:-/mnt/data/verder/mail-import/vandelay-x86_64-unknown-linux-musl/vandelay}"

mkdir -p "$OUT"

# ---------------------------------------------------------------------------
# Tier 1 — native snapshot, nightly. Fast to restore, and restorable ONLY by a
# Stalwart that still reads this on-disk RocksDB layout, which is precisely the
# thing still moving before 1.0. That is why tier 2 exists.
# ---------------------------------------------------------------------------

# Stalwart is stopped for the copy: RocksDB on a running server is not a
# consistent thing to tar, and a snapshot that restores into a corrupt store is
# worse than none. THE TRAP IS NOT OPTIONAL — without it a failing tar exits
# under `set -e` and leaves the mail server DOWN until someone notices. It is
# also why this runs after nightly-verify: a stopped Stalwart shows up as a red
# `mail` row within three minutes (worker-health.ts), and that signal is only
# useful if the ledger check has already run.
ARCHIVE="$OUT/native-$STAMP.tar.zst"

# TWO things must happen however this exits, and the second was learned the
# hard way on the first real run. Stalwart must come back up — without that a
# failing tar exits under `set -e` with the mail server down. And a FAILED
# ARCHIVE MUST NOT SURVIVE: that run died on `tar: etc: Cannot open: Permission
# denied`, tar carried on past the error as tar does, and zstd wrote 5.66 GB
# containing data/ and blobs/ but NOT etc/ — the precise
# restore-into-bootstrap-mode artifact this script exists to prevent, sitting on
# the NAS with a plausible name and size. A backup that cannot restore is worse
# than no backup, because only one of the two is honest about itself.
#
# STAGE THEN RENAME, the same crash-safe shape packages/api/src/storage.ts
# already uses for the vault: build under a `.partial` name and move it into
# place only once it is complete AND verified. The first version wrote straight
# to $ARCHIVE and deleted it on failure, which was measured destroying a GOOD
# backup: `zstd -o` refuses to overwrite, so a second run the same day failed at
# once, snapshot_ok stayed 0, and the cleanup removed the verified 5.59 GB
# archive the earlier run had written. A cron retry would have done the same.
# With a staging name a failed run cannot touch the archive that already exists,
# and $ARCHIVE only ever appears complete.
STAGING="$ARCHIVE.partial"
snapshot_ok=0
cleanup_snapshot() {
  "${COMPOSE[@]}" start stalwart >/dev/null 2>&1 || true
  if [ "$snapshot_ok" -eq 0 ] && [ -e "$STAGING" ]; then
    echo "mail-backup.sh: snapshot failed — removing $STAGING (the archive already" >&2
    echo "mail-backup.sh: in place, if any, is untouched)" >&2
    rm -f "$STAGING"
  fi
}
trap cleanup_snapshot EXIT
# A staging file left by a killed run must not be mistaken for progress.
rm -f "$STAGING"

"${COMPOSE[@]}" stop stalwart
# -C the PARENT and name the three children, so the archive restores with the
# same layout the compose file expects. Paths outside STORE_ROOT (someone has
# split the store across volumes) are archived separately rather than silently
# dropped — the `find` below only prunes what this script wrote.
if [ "$(dirname "$ETC_DIR")" = "$STORE_ROOT" ] && [ "$(dirname "$BLOB_DIR")" = "$STORE_ROOT" ]; then
  # sudo ON THE TAR ONLY. /etc/stalwart is mode 0750 owned by uid 2000 (the
  # image's unprivileged user), so the cron user cannot even open the directory
  # — measured: `tar: etc: Cannot open: Permission denied`. Raising the mode
  # instead would widen access to config.json, which holds the data-store
  # connection, so the read is privileged rather than the file being exposed.
  # zstd stays unprivileged, so the archive on the NAS is owned by the cron user
  # and the retention `find -delete` below can still remove it.
  sudo tar -C "$STORE_ROOT" -cf - \
    "$(basename "$ETC_DIR")" "$(basename "$DATA_DIR")" "$(basename "$BLOB_DIR")" \
    | zstd -q -o "$STAGING"
else
  echo "mail-backup.sh: store is split across volumes, archiving absolute paths" >&2
  sudo tar -cf - "$ETC_DIR" "$DATA_DIR" "$BLOB_DIR" | zstd -q -o "$STAGING"
fi
"${COMPOSE[@]}" start stalwart

# THE ACCEPTANCE TEST, and it is not "tar exited 0" — the same lesson the
# Vandelay import wrote down as "exited 0 is not evidence that anything
# arrived". The archive is read back and the ONE member whose absence is
# invisible at restore time is required to be in it. Listing costs a full
# decompress, which is a minute at 03:30 and is the difference between a backup
# and a rumour.
LIST=$(mktemp)
zstd -dc "$STAGING" | tar -tf - > "$LIST"
if ! grep -qx "$(basename "$ETC_DIR")/config.json" "$LIST"; then
  rm -f "$LIST"
  echo "mail-backup.sh: archive is missing $(basename "$ETC_DIR")/config.json — a restore" >&2
  echo "mail-backup.sh: from it would come up in BOOTSTRAP MODE on an empty store" >&2
  exit 1
fi
rm -f "$LIST"

# Verified, so it becomes the archive. `mv` within one filesystem is atomic:
# there is no instant at which native-$STAMP.tar.zst exists and is incomplete.
mv -f "$STAGING" "$ARCHIVE"
snapshot_ok=1
trap - EXIT

# 14 days, not 30. The store is ~7.3 GB and compresses to a few GB a night; in
# phase 1 it does not change at all, so thirty identical copies buy nothing that
# fourteen do not. Revisit when mail actually starts arriving.
find "$OUT" -name 'native-*.tar.zst' -mtime +14 -delete

# ---------------------------------------------------------------------------
# Tier 2 — version-independent archive, weekly.
#
# READ THIS BEFORE TRUSTING IT AS THE SURVIVAL COPY. The spec asked for
# MAILDIR, on the grounds that it "restores into anything: another Stalwart,
# Dovecot, Fastmail, back into Gmail". This is NOT Maildir — Vandelay cannot
# write one (see the header). What a Vandelay archive buys is narrower and
# still real: it is a documented SQLite file that any Stalwart can be fed
# through its JMAP API, so it does NOT depend on the pre-1.0 on-disk format the
# way tier 1 does. What it does not buy is escape from Stalwart itself, and the
# spec's own research says Stalwart is the only practical self-hosted JMAP
# server. So the escape hatch today is IMAP4rev2 out of a restored server, not
# this file. A real Maildir writer remains an open decision.
# ---------------------------------------------------------------------------
if [ ! -f "$OUT/archive-$WEEK.sqlite.zst" ] && [ ! -f "$OUT/archive-$WEEK.sqlite.zst.age" ]; then
  if [ ! -x "$VANDELAY" ]; then
    echo "mail-backup.sh: vandelay not executable at $VANDELAY — weekly archive SKIPPED" >&2
  else
    # Self-healing, because /mnt/data/verder is root-owned 0755 and the cron
    # user cannot mkdir inside it — measured: `mkdir: cannot create directory
    # '/mnt/data/verder/mail-backup-tmp': Permission denied`, AFTER tier 1 had
    # already succeeded. A backup script that needs a manual mkdir before it
    # works is one that silently does half its job on a rebuilt machine, which
    # is exactly the machine a backup script is for. sudo creates it, then hands
    # it to the caller so everything below runs unprivileged.
    if [ ! -d "$SCRATCH_ROOT" ]; then
      sudo mkdir -p "$SCRATCH_ROOT"
      sudo chown "$(id -u):$(id -g)" "$SCRATCH_ROOT"
    fi
    TMP=$(mktemp -d "$SCRATCH_ROOT/wk-XXXXXX")
    # shellcheck disable=SC2064
    trap "rm -rf '$TMP'" EXIT
    # RUN IT INSIDE THE COMPOSE NETWORK, not on the host. JMAP_BASE_URL is
    # http://stalwart:8080 and that name resolves ONLY between containers —
    # measured on the host as `failed to lookup address information: Try again`.
    # docs/deploy.md §8.7 offers `127.0.0.1 stalwart` in /etc/hosts instead, and
    # that works, but it is host-wide state a rebuilt machine will not have: the
    # same silent half-working backup the scratch directory above already
    # taught. Pointing at 127.0.0.1:8080 does not help either — discovery would
    # succeed and the SESSION still hands back apiUrl http://stalwart:8080/jmap/
    # (STALWART_PUBLIC_URL), so the first method call goes nowhere.
    #
    # --user runs it as the calling user, so the 12.5 GB archive lands owned by
    # the cron user rather than root and the cleanup below can remove it.
    # --no-deps because postgres is irrelevant here and starting it would be a
    # side effect. -e passes the name only: `-e VAR=value` would put the app
    # password in the process table for every user on the box, which is the same
    # reason --auth-password is not used.
    VANDELAY_PASSWORD="${JMAP_APP_PASSWORD:?}" "${COMPOSE[@]}" run --rm -T --no-deps \
      --user "$(id -u):$(id -g)" \
      -e VANDELAY_PASSWORD \
      -v "$VANDELAY:/usr/local/bin/vandelay:ro" \
      -v "$TMP:/out" \
      --entrypoint /usr/local/bin/vandelay \
      worker import jmap \
      --url "${JMAP_BASE_URL:?}" \
      --auth-basic "${JMAP_USER:?}" \
      --account-name "${JMAP_USER:?}" \
      /out/archive.sqlite

    if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
      # Encrypted BEFORE it can reach a third party. The key lives in the
      # password manager and on paper, never only on this machine — losing the
      # homelab must not lose the backups with it.
      command -v age >/dev/null || {
        echo "mail-backup.sh: BACKUP_AGE_RECIPIENT is set but \`age\` is not installed" >&2
        exit 1
      }
      zstd -q -c "$TMP/archive.sqlite" | age -r "$BACKUP_AGE_RECIPIENT" \
        -o "$OUT/archive-$WEEK.sqlite.zst.age"
    else
      # No recipient configured, so this stays IN THE HOUSE. BACKUP_DIR is the
      # NAS, not Dropbox or TransIP Stack, and the spec requires encryption
      # "before it leaves" — it is not a blanket rule. The loud line is the
      # point: whoever wires up an off-site target must set a recipient first,
      # and this file is not fit to be copied there as it stands.
      echo "mail-backup.sh: BACKUP_AGE_RECIPIENT unset — archive written UNENCRYPTED" >&2
      echo "mail-backup.sh: it holds bewindvoering correspondence; do NOT copy it off-site" >&2
      zstd -q -o "$OUT/archive-$WEEK.sqlite.zst" "$TMP/archive.sqlite"
    fi
    rm -rf "$TMP"
    trap - EXIT
  fi
fi

# Five weeks, so a monthly restore drill always has a second-newest to fall back
# on if the newest is the one that turns out to be broken.
find "$OUT" -name 'archive-*.sqlite.zst*' -mtime +35 -delete

echo "mail-backup.sh: done ($STAMP, week $WEEK)"
