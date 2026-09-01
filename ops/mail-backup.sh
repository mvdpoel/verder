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
restart_stalwart() { "${COMPOSE[@]}" start stalwart >/dev/null 2>&1 || true; }
trap restart_stalwart EXIT

"${COMPOSE[@]}" stop stalwart
# -C the PARENT and name the three children, so the archive restores with the
# same layout the compose file expects. Paths outside STORE_ROOT (someone has
# split the store across volumes) are archived separately rather than silently
# dropped — the `find` below only prunes what this script wrote.
if [ "$(dirname "$ETC_DIR")" = "$STORE_ROOT" ] && [ "$(dirname "$BLOB_DIR")" = "$STORE_ROOT" ]; then
  tar -C "$STORE_ROOT" -cf - \
    "$(basename "$ETC_DIR")" "$(basename "$DATA_DIR")" "$(basename "$BLOB_DIR")" \
    | zstd -q -o "$OUT/native-$STAMP.tar.zst"
else
  echo "mail-backup.sh: store is split across volumes, archiving absolute paths" >&2
  tar -cf - "$ETC_DIR" "$DATA_DIR" "$BLOB_DIR" | zstd -q -o "$OUT/native-$STAMP.tar.zst"
fi
"${COMPOSE[@]}" start stalwart
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
    mkdir -p "$SCRATCH_ROOT"
    TMP=$(mktemp -d "$SCRATCH_ROOT/wk-XXXXXX")
    # shellcheck disable=SC2064
    trap "rm -rf '$TMP'" EXIT
    # --auth-password is avoided: it would put the app password in the process
    # table for every user on the box. Vandelay reads $VANDELAY_PASSWORD.
    VANDELAY_PASSWORD="${JMAP_APP_PASSWORD:?}" "$VANDELAY" import jmap \
      --url "${JMAP_BASE_URL:?}" \
      --auth-basic "${JMAP_USER:?}" \
      --account-name "${JMAP_USER:?}" \
      "$TMP/archive.sqlite"

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
