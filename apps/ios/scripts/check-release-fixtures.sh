#!/usr/bin/env bash
# Proves the BUILT Release app holds no fixture: no FixtureData folder, and no
# fixture symbol or string in the binary. FixtureIsolationTests pins the
# source side; this checks what a Release build actually produced.
#   scripts/check-release-fixtures.sh
# Builds Release for the simulator, unsigned, into build/DD-release.
set -euo pipefail
cd "$(dirname "$0")/.."
xcodegen -q
env -u NODE_ENV xcodebuild build -scheme Grip -configuration Release \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath build/DD-release \
  CODE_SIGNING_ALLOWED=NO -quiet
APP=build/DD-release/Build/Products/Release-iphonesimulator/Grip.app
fail=0
if [ -e "$APP/FixtureData" ]; then echo "FAIL: $APP/FixtureData exists" >&2; fail=1; fi
for needle in FixtureProtocol FixtureServer FixtureLaunch FixtureEnvironment fixtures.grip.invalid -fixtures-locked; do
  # A Debug build keeps its code in Grip.debug.dylib; read every binary.
  if cat "$APP/Grip" "$APP"/*.dylib 2>/dev/null | strings -a | grep -q -- "$needle"; then echo "FAIL: '$needle' is in the Release binary" >&2; fail=1; fi
done
# The check must be able to fail: the Debug build of the same app has them.
[ "$fail" = 0 ] && echo "OK: the Release build holds no fixture code or data"
exit "$fail"
