#!/usr/bin/env bash
# Screenshot one screen of the app on the synthetic dataset, in the simulator.
#   scripts/capture.sh <fixture> <tab|route> <out.png> [--locked]
#
#   fixture  a folder in Verder/FixtureData (voorjou-few, voorjou-many, voorjou-long,
#            empty, offline, unauthorized, money-complete, money-partial,
#            money-geen-data, money-empty, dossier, weekly, voice)
#   tab      overzicht | voorjou | scan | dossier | meer
#   route    proposal:<id> | suggestion:<id> | task:<id> | geld | weekly | voice
#   --locked keep the app lock closed (Overzicht's counts-only glance)
#
# A DEBUG build (the fixtures are compiled out of Release), installed on the
# "iPhone 17" simulator, booted if it is not. Nothing reaches a server: every
# /api/mobile/v1 call is answered from the bundled synthetic JSON.
#
# Env: DEVICE (simulator name, default "iPhone 17"), SKIP_BUILD=1 to reuse the
# last build, SETTLE (seconds to wait before the shot, default 3).
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

case "$TARGET" in
  overzicht|voorjou|scan|dossier|meer) ARGS=(-tab "$TARGET") ;;
  *) ARGS=(-route "$TARGET") ;;
esac
[ -z "$LOCKED" ] || ARGS+=(-fixtures-locked)

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
xcrun simctl launch "$UDID" "$BUNDLE" -fixtures "$FIXTURE" "${ARGS[@]}" >/dev/null
sleep "${SETTLE:-3}"
mkdir -p "$(dirname "$OUT")"
xcrun simctl io "$UDID" screenshot --type=png "$OUT" >/dev/null 2>&1
echo "$OUT"
