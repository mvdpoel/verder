#!/usr/bin/env bash
# Build a development-signed Release build and install + launch it on Martin's iPhone.
#   scripts/install.sh [devicectl-id]
# Needs: Xcode signed into team 7RKC7FRL24, Local.xcconfig, the phone unlocked and trusted.
set -euo pipefail
cd "$(dirname "$0")/.."
DEVICE="${1:-${VERDER_DEVICE:-4151AD85-3F8B-5DE7-9B5F-CCD2534206A5}}"
[ -f Local.xcconfig ] || { echo "install.sh: copy Local.xcconfig.example to Local.xcconfig" >&2; exit 1; }
xcodegen -q
env -u NODE_ENV xcodebuild build -scheme Verder -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath build/DD \
  -allowProvisioningUpdates -quiet
APP=build/DD/Build/Products/Release-iphoneos/Verder.app
xcrun devicectl device install app --device "$DEVICE" "$APP"
xcrun devicectl device process launch --device "$DEVICE" --terminate-existing pro.vanderpoel.verder
