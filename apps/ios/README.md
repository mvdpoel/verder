# Grip for iPhone

Native SwiftUI app (iOS 27, iPhone only, dark only). Spec:
`docs/superpowers/specs/2026-10-28-iphone-app-design.md`; plan:
`docs/superpowers/plans/2026-10-28-iphone-app.md`.

## Build and test

```sh
brew install xcodegen
cp Local.xcconfig.example Local.xcconfig      # Team ID 7RKC7FRL24, gitignored
xcodegen                                      # Grip.xcodeproj is generated, never committed
env -u NODE_ENV xcodebuild test -scheme Grip \
  -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath build/DD
```

The tests read `apps/web/src/app/globals.css` from disk (token drift guard), so run
them from a full checkout.

## Screenshots on synthetic data (DEBUG only)

```sh
scripts/capture.sh voorjou-few overzicht out/overzicht.png
scripts/capture.sh voorjou-few overzicht out/overzicht-locked.png --locked
scripts/capture.sh voorjou-many voorjou out/voorjou-498.png
scripts/capture.sh voorjou-few proposal:00000000-f1c5-4000-8000-000000000002 out/question.png
scripts/capture.sh dossier dossier out/dossier.png
# A notification as iOS draws it (lock screen, banner, long press); see --notify in capture.sh.
# Use a simulator of its own, in Dutch and dark mode, so pushes and Settings changes stay off
# the shared "iPhone 17": `xcrun simctl create "iPhone 17 Meldingen" "iPhone 17"`, then
# `simctl spawn <udid> defaults write -g AppleLanguages -array nl-NL` and `simctl ui <udid> appearance dark`.
DEVICE="iPhone 17 Meldingen" scripts/capture.sh meldingen voorjou out/vraag.png --notify vraag
DEVICE="iPhone 17 Meldingen" scripts/capture.sh meldingen-offline voorjou out/gedaan.png --notify gedaan-notice
scripts/capture.sh dossier document:00000000-f1c5-4000-8000-200000000311 out/viewer.png
```

A Debug build launched with `-fixtures <name>` answers every `/api/mobile/v1` call
from `Grip/FixtureData/<name>` (falling back to `_shared/`) through the real stores,
signed in and unlocked, with no server. Also `-tab`, `-route` and `-fixtures-locked`;
the fixtures and their data are listed in
`docs/superpowers/specs/2026-11-01-iphone-synthetic-data.md`, the ONLY data a fixture
may hold (screenshots leave this machine). None of it is in a Release build:
`scripts/check-release-fixtures.sh` checks the built bundle.

The `dossier` fixture's documents are real tiny PDFs. Regenerate them (with the
`sync.json` and `texts.json` that name their hashes) only together, from the repo root:
`swiftc -O apps/ios/scripts/make-dossier-fixtures.swift -o /tmp/mdf && /tmp/mdf apps/ios/Grip/FixtureData/_shared`.

`capture.sh` refuses a target the app would not read (exit 2) and never writes the
PNG if the app is not running before and after the shot (exit 1) — a dead app would
otherwise leave the home screen to be saved as an app screen. Its tests:
`scripts/test-capture.sh` (arguments only) or `scripts/test-capture.sh --live`
(launches the last Debug build).

## Install on Martin's iPhone

```sh
scripts/install.sh            # Release build, development-signed, devicectl install + launch
```

Needs Xcode signed into team 7RKC7FRL24 (Settings → Apple Accounts), the phone
plugged in, unlocked and trusted, and Developer Mode on. The launch step fails with
`Locked` when the phone is locked; the install itself has then still succeeded.

## Passkeys

The entitlement is `webcredentials:grip.vanderpoel.pro?mode=developer`. In developer
mode iOS fetches the association file from the device itself, and ONLY when
**Settings → Developer → Associated Domains Development** is on; it checks at install
time, so reinstall after flipping it. Without it every passkey call fails with
`ASAuthorizationError 1004 … is not associated with domain`. Error `1006` is not a
failure: a passkey for the account is already on the phone (iCloud Keychain synced
the Mac's), and the app says so.

## Re-signing every year

The development certificate and provisioning profile expire **2027-10-31**. Before
then: open Xcode once (Settings → Apple Accounts must show the team; accept any new
Program License Agreement at developer.apple.com/account — an unaccepted PLA makes
every build fail with "PLA Update available"), then run `scripts/install.sh`. Xcode
renews both automatically. An expired profile means the app no longer opens; data in
the Keychain and the App Group survives a reinstall.
