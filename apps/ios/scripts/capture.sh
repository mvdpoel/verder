#!/usr/bin/env bash
# Screenshot one screen of the app on the synthetic dataset, in the simulator.
#   scripts/capture.sh <fixture> <tab|route> <out.png> [--locked]
#
#   fixture  a folder in Verder/FixtureData (voorjou-few, voorjou-many, voorjou-long,
#            empty, offline, unauthorized, money-complete, money-partial,
#            money-geen-data, money-empty, money-no-account, money-unrecognised,
#            money-no-budget, money-overspent, dossier, timeline, weekly, voice)
#   tab      overzicht | voorjou | scan | dossier | meer
#   route    proposal:<id> | suggestion:<id> | task:<id> | document:<id> | geld | weekly | timeline | voice
#   --locked keep the app lock closed (Overzicht's counts-only glance)
#
# A DEBUG build (the fixtures are compiled out of Release), installed on the
# "iPhone 17" simulator, booted if it is not. Nothing reaches a server: every
# /api/mobile/v1 call is answered from the bundled synthetic JSON.
#
# Env: DEVICE (simulator name, default "iPhone 17"), SKIP_BUILD=1 to reuse the
# last build, SETTLE (seconds to wait before the shot, default 3).
# CAPTURE_CHECK_ONLY=1 validates the arguments and exits (no simulator).
# CAPTURE_UNCHECKED_TARGET=1 skips the target grammar check — ONLY for
# scripts/test-capture.sh, which needs a bad route to reach the app to prove
# the liveness check below catches it.
#
# Never writes <out.png> unless the app was still running before AND after the
# shot: FixtureLaunch.current fatalErrors on a launch argument it cannot read,
# and a dead app leaves the simulator home screen to be screenshotted.
set -euo pipefail
usage() { echo "usage: scripts/capture.sh <fixture> <tab|route> <out.png> [--locked]" >&2; exit 2; }
[ $# -ge 3 ] || usage
FIXTURE="$1"; TARGET="$2"; OUT="$3"; LOCKED="${4:-}"
[ -z "$LOCKED" ] || [ "$LOCKED" = "--locked" ] || usage
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac

cd "$(dirname "$0")/.."
DEVICE="${DEVICE:-iPhone 17}"
BUNDLE=pro.vanderpoel.verder
[ -d "Verder/FixtureData/$FIXTURE" ] && [ "$FIXTURE" != "_shared" ] || {
  echo "capture.sh: no fixture '$FIXTURE'; known: $(ls Verder/FixtureData | grep -v '^_' | tr '\n' ' ')" >&2; exit 2; }

# The app's own grammar (FixtureLaunch.Tab, .Screen, DeepLink.parse's UUID ids),
# so a typo stops here rather than in a crashed app.
HEX='[0-9A-Fa-f]'
UUID_RE="^$HEX{8}-$HEX{4}-$HEX{4}-$HEX{4}-$HEX{12}\$"
case "$TARGET" in
  overzicht|voorjou|scan|dossier|meer) ARGS=(-tab "$TARGET") ;;
  geld|weekly|timeline|voice) ARGS=(-route "$TARGET") ;;
  proposal:*|suggestion:*|task:*|document:*)
    if [ "${CAPTURE_UNCHECKED_TARGET:-0}" != 1 ] && ! [[ "${TARGET#*:}" =~ $UUID_RE ]]; then
      echo "capture.sh: '$TARGET' — the id after '${TARGET%%:*}:' must be a UUID" >&2; exit 2
    fi
    ARGS=(-route "$TARGET") ;;
  *)
    if [ "${CAPTURE_UNCHECKED_TARGET:-0}" != 1 ]; then
      echo "capture.sh: unknown target '$TARGET'; tabs: overzicht voorjou scan dossier meer;" \
        "routes: geld weekly timeline voice proposal:<uuid> suggestion:<uuid> task:<uuid> document:<uuid>" >&2; exit 2
    fi
    ARGS=(-route "$TARGET") ;;
esac
[ -z "$LOCKED" ] || ARGS+=(-fixtures-locked)
[ "${CAPTURE_CHECK_ONLY:-0}" != 1 ] || { echo "capture.sh: arguments OK"; exit 0; }

UDID="$(xcrun simctl list devices available | grep -E "^ +$DEVICE \(" | head -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')"
[ -n "$UDID" ] || { echo "capture.sh: no available simulator named '$DEVICE'" >&2; exit 1; }

if [ "${SKIP_BUILD:-0}" != 1 ]; then
  [ -f Local.xcconfig ] || { echo "capture.sh: copy Local.xcconfig.example to Local.xcconfig" >&2; exit 1; }
  xcodegen -q
  env -u NODE_ENV xcodebuild build -scheme Verder -configuration Debug \
    -destination "id=$UDID" -derivedDataPath build/DD -quiet
fi
APP=build/DD/Build/Products/Debug-iphonesimulator/Verder.app
[ -d "$APP/FixtureData" ] || { echo "capture.sh: $APP has no FixtureData (not a Debug build?)" >&2; exit 1; }

xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null
# The reference frame's status bar, so captures compare against Figma.
xcrun simctl status_bar "$UDID" override --time 9:41 --dataNetwork wifi --wifiMode active --wifiBars 3 \
  --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100
xcrun simctl install "$UDID" "$APP"
xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
# `simctl launch` prints "<bundle>: <pid>"; a simulator app is a host process.
LAUNCHED="$(xcrun simctl launch "$UDID" "$BUNDLE" -fixtures "$FIXTURE" "${ARGS[@]}")"
PID="${LAUNCHED##*: }"
[[ "$PID" =~ ^[0-9]+$ ]] || { echo "capture.sh: could not read the app's pid from '$LAUNCHED'" >&2; exit 1; }
alive() { kill -0 "$PID" 2>/dev/null; }
died() {
  echo "capture.sh: the app exited $1 (pid $PID) — not writing $OUT." >&2
  echo "  A launch argument it cannot read is a fatalError; see the simulator log:" >&2
  echo "  xcrun simctl spawn $UDID log show --last 2m --predicate 'process == \"Verder\"'" >&2
  exit 1
}
sleep "${SETTLE:-3}"
alive || died "before the screenshot"
mkdir -p "$(dirname "$OUT")"
TMP="$OUT.partial.png"
trap 'rm -f "$TMP"' EXIT
xcrun simctl io "$UDID" screenshot --type=png "$TMP" >/dev/null 2>&1
alive || died "during the screenshot"
mv -f "$TMP" "$OUT"
echo "$OUT"
