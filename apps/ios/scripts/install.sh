#!/usr/bin/env bash
# Build a development-signed Release build and install + launch it on Martin's iPhone.
#   scripts/install.sh [devicectl-id]
#   GRIP_CONFIGURATION=Debug scripts/install.sh   (a Debug build, e.g. for the
#   call-dial trace in CallSession.traceDial; read it in Console.app)
# Needs: Xcode signed into team 7RKC7FRL24, Local.xcconfig, the phone unlocked and trusted.
set -euo pipefail
# A fresh build number per install: iOS caches the home-screen icon per bundle
# version, so an unchanged CFBundleVersion kept the old blank icon (2026-10-31).
cd "$(dirname "$0")/.."
DEVICE="${1:-${GRIP_DEVICE:-4151AD85-3F8B-5DE7-9B5F-CCD2534206A5}}"
[ -f Local.xcconfig ] || { echo "install.sh: copy Local.xcconfig.example to Local.xcconfig" >&2; exit 1; }
CONFIG="${GRIP_CONFIGURATION:-Release}"
xcodegen -q
env -u NODE_ENV xcodebuild build -scheme Grip -configuration "$CONFIG" \
  -destination 'generic/platform=iOS' -derivedDataPath build/DD \
  -allowProvisioningUpdates -quiet \
  CURRENT_PROJECT_VERSION="$(date +%Y%m%d%H%M)"
APP="build/DD/Build/Products/$CONFIG-iphoneos/Grip.app"
xcrun devicectl device install app --device "$DEVICE" "$APP"
xcrun devicectl device process launch --device "$DEVICE" --terminate-existing pro.vanderpoel.grip
