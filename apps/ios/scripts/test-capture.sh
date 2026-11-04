#!/usr/bin/env bash
# Tests for scripts/capture.sh: a capture must never save a screenshot of the
# wrong screen and exit 0.
#   scripts/test-capture.sh          argument checks only (no simulator)
#   scripts/test-capture.sh --live   also launches the Debug build (SKIP_BUILD=1:
#                                    build it first, e.g. with the test command)
set -uo pipefail
cd "$(dirname "$0")/.."
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
expect() { # <want-exit> <description> <cmd...>
  local want="$1" what="$2"; shift 2
  "$@" >"$TMP/log" 2>&1; local got=$?
  if [ "$got" = "$want" ]; then echo "ok   $what"; else echo "FAIL $what: exit $got, wanted $want"; sed 's/^/     /' "$TMP/log"; fail=1; fi
}
check() { CAPTURE_CHECK_ONLY=1 scripts/capture.sh voorjou-few "$1" "$TMP/x.png"; }

for good in overzicht voorjou scan dossier meer geld weekly timeline voice \
  proposal:00000000-f1c5-4000-8000-000000000002 suggestion:00000000-F1C5-4000-8000-000000000003 \
  task:00000000-f1c5-4000-8000-000000000004 document:00000000-f1c5-4000-8000-200000000311 \
  meer:account meer:notifications meer:widgets meer:about meer:developer \
  widget:thuis-volle-kleur widget:groot-afgemeld widget:toegang-wacht widget:standby-nacht \
  share:een-pdf share:deelblad share:te-groot; do
  expect 0 "accepts $good" check "$good"
done
for bad in proposal:nope suggestion:123 task: task:00000000-f1c5-4000-8000-00000000000 \
  proposal:00000000-f1c5-4000-8000-000000000002/x document:nope inbox:00000000-f1c5-4000-8000-000000000002 \
  Overzicht bogus inbox meer:geheim meer: widget: widget:thuis widget:standby-dag share: share:pdf; do
  expect 2 "refuses $bad" check "$bad"
done
for g in open nov sep sheet; do
  expect 0 "accepts --geld $g" env CAPTURE_CHECK_ONLY=1 scripts/capture.sh money-partial overzicht "$TMP/x.png" --geld "$g"
done
for m in signout savefail; do
  expect 0 "accepts --more $m" env CAPTURE_CHECK_ONLY=1 scripts/capture.sh voorjou-few meer:account "$TMP/x.png" --more "$m"
done
expect 2 "refuses --more uitloggen" env CAPTURE_CHECK_ONLY=1 scripts/capture.sh voorjou-few meer:account "$TMP/x.png" --more uitloggen
for p in denied notDetermined; do
  expect 0 "accepts --push $p" env CAPTURE_CHECK_ONLY=1 scripts/capture.sh voorjou-few meer "$TMP/x.png" --push "$p"
done
expect 2 "refuses --push aan" env CAPTURE_CHECK_ONLY=1 scripts/capture.sh voorjou-few meer "$TMP/x.png" --push aan
expect 0 "accepts --text-size ax5" env CAPTURE_CHECK_ONLY=1 scripts/capture.sh voorjou-few meer "$TMP/x.png" --text-size ax5
expect 0 "accepts --scroll middle" env CAPTURE_CHECK_ONLY=1 scripts/capture.sh voorjou-few meer:account "$TMP/x.png" --scroll middle
expect 2 "refuses --geld okt" env CAPTURE_CHECK_ONLY=1 scripts/capture.sh money-partial overzicht "$TMP/x.png" --geld okt
expect 2 "refuses an unknown fixture" env CAPTURE_CHECK_ONLY=1 scripts/capture.sh nope overzicht "$TMP/x.png"

if [ "${1:-}" = --live ]; then
  # The app itself refuses this route (fatalError); the grammar check is
  # skipped so the liveness check is what has to catch it.
  expect 1 "a crashed app exits non-zero" env SKIP_BUILD=1 CAPTURE_UNCHECKED_TARGET=1 \
    scripts/capture.sh voorjou-few proposal:nope "$TMP/dead.png"
  if [ -e "$TMP/dead.png" ] || [ -e "$TMP/dead.png.partial.png" ]; then echo "FAIL a crashed app left a PNG"; fail=1; else echo "ok   a crashed app leaves no PNG"; fi
  expect 0 "a live app is captured" env SKIP_BUILD=1 scripts/capture.sh voorjou-few overzicht "$TMP/live.png"
  if [ -s "$TMP/live.png" ]; then echo "ok   the live capture wrote a PNG"; else echo "FAIL the live capture wrote no PNG"; fail=1; fi
fi
exit "$fail"
