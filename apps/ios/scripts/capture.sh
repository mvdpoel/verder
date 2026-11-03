#!/usr/bin/env bash
# Screenshot one screen of the app on the synthetic dataset, in the simulator.
#   scripts/capture.sh <fixture> <tab|route> <out.png> [--locked] [--scans] [--scrolled]
#                      [--text-size <size>] [--queue <preset>] [--camera <state>] [--scan <state>]
#                      [--press <text>] [--geld <state>]
#
#   fixture  a folder in Verder/FixtureData (voorjou-few, voorjou-many, voorjou-long,
#            empty, offline, unauthorized, calm, one-item, loading, server-error,
#            server-error-cached, offline-cached, money-complete, money-partial,
#            money-geen-data, money-empty, money-no-account, money-unrecognised,
#            money-no-budget, money-overspent, dossier, timeline, weekly, voice)
#   tab      overzicht | voorjou | scan | dossier | meer
#   route    proposal:<id> | suggestion:<id> | task:<id> | document:<id> | geld | weekly | timeline | voice
#   --locked keep the app lock closed (Overzicht's counts-only glance)
#   --scans  the phone's upload queue holds today's scans (2 sent, 1 waiting)
#   --scrolled  open Overzicht scrolled to its end (the lower half of a
#            "hele pagina" frame); --scroll <waiting|leefgeld|rest|end> to a card
#            (waiting: the end of Wacht op jou, at the bottom of the screen)
#   --text-size  the simulator's Dynamic Type size for this shot, as simctl
#            spells it (e.g. accessibility-extra-extra-extra-large for AX5,
#            large for the default); the previous size is put back afterwards
#   --queue  the Scan tab's upload queue as a "scan · final" frame draws it:
#            first underway done offline failed failed-recent signin signin-recent
#   --camera the camera permission: notDetermined | denied (default: allowed)
#   --scan   open Scan on a state only a gesture reaches:
#            handoff (the page mid-flight into the queue) | queue (the Wachtrij
#            sheet) | note ("Iets bijzonders?") | preprompt (the camera pre-prompt)
#   --geld   push Geld from Overzicht, as the money card's tap does (tab overzicht):
#            open | nov (beheerrekening on November, leefgeldrekening on
#            September) | sep (beheerrekening on September) | sheet ("Niet in
#            de balken" for the beheerrekening)
#   --press  long-press the text that reads exactly <text> and shoot what that
#            opens (with --scan queue: the row menu, "Wachtrij / rij-acties").
#            A simulator cannot be long-pressed from the shell, so the app is
#            launched and pressed by the VerderCapture UI test instead.
#
# A DEBUG build (the fixtures are compiled out of Release), installed on the
# "iPhone 17" simulator, booted if it is not. Nothing reaches a server: every
# /api/mobile/v1 call is answered from the bundled synthetic JSON.
#
# Env: DEVICE (simulator name, default "iPhone 17"), SKIP_BUILD=1 to reuse the
# last build, SETTLE (seconds to wait before the shot, default 3; 68 for a
# fixture with "thenFail", whose state — the kept board after a failed
# refresh — appears only once Overzicht's one-minute poll has asked again:
# at 3 s it is the first good load, identical to the base case).
# CAPTURE_CHECK_ONLY=1 validates the arguments and exits (no simulator).
# CAPTURE_UNCHECKED_TARGET=1 skips the target grammar check — ONLY for
# scripts/test-capture.sh, which needs a bad route to reach the app to prove
# the liveness check below catches it.
#
# Never writes <out.png> unless the app was still running before AND after the
# shot: FixtureLaunch.current fatalErrors on a launch argument it cannot read,
# and a dead app leaves the simulator home screen to be screenshotted.
set -euo pipefail
usage() { echo "usage: scripts/capture.sh <fixture> <tab|route> <out.png> [--locked] [--scans] [--scrolled | --scroll <card>] [--text-size <size>] [--queue <preset>] [--camera <state>] [--scan <state>] [--press <text>] [--geld <state>]" >&2; exit 2; }
[ $# -ge 3 ] || usage
FIXTURE="$1"; TARGET="$2"; OUT="$3"; shift 3
LOCKED=""; SCANS=""; SCROLLED=""; TEXT_SIZE=""; QUEUE=""; CAMERA=""; SCAN_STATE=""; PRESS=""; GELD=""
TEXT_SIZES="extra-small small medium large extra-large extra-extra-large extra-extra-extra-large accessibility-medium accessibility-large accessibility-extra-large accessibility-extra-extra-large accessibility-extra-extra-extra-large"
while [ $# -gt 0 ]; do
  case "$1" in
    --locked) LOCKED=1 ;;
    --scans) SCANS=1 ;;
    --scrolled) SCROLLED=end ;;
    --scroll)
      [ $# -ge 2 ] || usage
      case "$2" in waiting|leefgeld|rest|end) SCROLLED="$2" ;; *) echo "capture.sh: --scroll takes waiting, leefgeld, rest or end" >&2; exit 2 ;; esac
      shift ;;
    --text-size)
      [ $# -ge 2 ] || usage
      case " $TEXT_SIZES " in *" $2 "*) TEXT_SIZE="$2" ;; *) echo "capture.sh: unknown text size '$2'; known: $TEXT_SIZES" >&2; exit 2 ;; esac
      shift ;;
    --queue)
      [ $# -ge 2 ] || usage
      case "$2" in first|underway|done|offline|failed|failed-recent|signin|signin-recent) QUEUE="$2" ;;
        *) echo "capture.sh: --queue takes first, underway, done, offline, failed, failed-recent, signin or signin-recent" >&2; exit 2 ;; esac
      shift ;;
    --camera)
      [ $# -ge 2 ] || usage
      case "$2" in notDetermined|denied) CAMERA="$2" ;; *) echo "capture.sh: --camera takes notDetermined or denied" >&2; exit 2 ;; esac
      shift ;;
    --scan)
      [ $# -ge 2 ] || usage
      case "$2" in handoff|queue|note|preprompt) SCAN_STATE="$2" ;; *) echo "capture.sh: --scan takes handoff, queue, note or preprompt" >&2; exit 2 ;; esac
      shift ;;
    --geld)
      [ $# -ge 2 ] || usage
      case "$2" in open|nov|sep|sheet) GELD="$2" ;; *) echo "capture.sh: --geld takes open, nov, sep or sheet" >&2; exit 2 ;; esac
      shift ;;
    --press)
      [ $# -ge 2 ] && [ -n "$2" ] || usage
      PRESS="$2"
      shift ;;
    *) usage ;;
  esac
  shift
done
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
[ -z "$SCANS" ] || ARGS+=(-fixtures-scans)
[ -z "$SCROLLED" ] || ARGS+=(-fixtures-scroll "$SCROLLED")
[ -z "$QUEUE" ] || ARGS+=(-fixtures-queue "$QUEUE")
[ -z "$CAMERA" ] || ARGS+=(-fixtures-camera "$CAMERA")
[ -z "$SCAN_STATE" ] || ARGS+=(-fixtures-scan "$SCAN_STATE")
[ -z "$GELD" ] || ARGS+=(-fixtures-geld "$GELD")
[ "${CAPTURE_CHECK_ONLY:-0}" != 1 ] || { echo "capture.sh: arguments OK"; exit 0; }

# -F: a name such as "iPhone SE (3rd generation)" holds regex metacharacters.
UDID="$(xcrun simctl list devices available | grep -F "    $DEVICE (" | head -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')"
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
if [ -n "$TEXT_SIZE" ]; then
  PREV_SIZE="$(xcrun simctl ui "$UDID" content_size 2>/dev/null || echo large)"
  xcrun simctl ui "$UDID" content_size "$TEXT_SIZE"
fi
restore_size() { [ -z "$TEXT_SIZE" ] || xcrun simctl ui "$UDID" content_size "${PREV_SIZE:-large}" 2>/dev/null || true; }
trap restore_size EXIT
xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
if [ -n "$PRESS" ]; then
  # The UI test launches the app with these arguments, presses, and writes
  # the PNG itself; it fails (and writes nothing) if the text is not on screen.
  ALL_ARGS=(-fixtures "$FIXTURE" "${ARGS[@]}")
  mkdir -p "$(dirname "$OUT")"
  rm -f "$OUT.partial.png"
  TEST_RUNNER_CAPTURE_ARGS="$(printf '%s\n' "${ALL_ARGS[@]}")" TEST_RUNNER_CAPTURE_PRESS="$PRESS" \
    TEST_RUNNER_CAPTURE_OUT="$OUT.partial.png" \
    env -u NODE_ENV xcodebuild test -scheme VerderCapture -destination "id=$UDID" \
    -derivedDataPath build/DD -quiet >/dev/null \
    || { echo "capture.sh: the --press capture failed — not writing $OUT." >&2; rm -f "$OUT.partial.png"; exit 1; }
  [ -s "$OUT.partial.png" ] || { echo "capture.sh: the --press capture wrote no PNG." >&2; exit 1; }
  mv -f "$OUT.partial.png" "$OUT"
  echo "$OUT"
  exit 0
fi
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
DEFAULT_SETTLE=3
grep -q '"thenFail"' "Verder/FixtureData/$FIXTURE/fixture.json" && DEFAULT_SETTLE=68
sleep "${SETTLE:-$DEFAULT_SETTLE}"
alive || died "before the screenshot"
mkdir -p "$(dirname "$OUT")"
TMP="$OUT.partial.png"
trap 'rm -f "$TMP"; restore_size' EXIT
xcrun simctl io "$UDID" screenshot --type=png "$TMP" >/dev/null 2>&1
alive || died "during the screenshot"
mv -f "$TMP" "$OUT"
echo "$OUT"
