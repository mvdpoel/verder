# verder for iPhone

Native SwiftUI app (iOS 27, iPhone only, dark only). Spec:
`docs/superpowers/specs/2026-10-28-iphone-app-design.md`; plan:
`docs/superpowers/plans/2026-10-28-iphone-app.md`.

## Build and test

```sh
brew install xcodegen
cp Local.xcconfig.example Local.xcconfig      # Team ID 7RKC7FRL24, gitignored
xcodegen                                      # Verder.xcodeproj is generated, never committed
env -u NODE_ENV xcodebuild test -scheme Verder \
  -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath build/DD
```

The tests read `apps/web/src/app/globals.css` from disk (token drift guard), so run
them from a full checkout.

## Install on Martin's iPhone

```sh
scripts/install.sh            # Release build, development-signed, devicectl install + launch
```

Needs Xcode signed into team 7RKC7FRL24 (Settings → Apple Accounts), the phone
plugged in, unlocked and trusted, and Developer Mode on. The launch step fails with
`Locked` when the phone is locked; the install itself has then still succeeded.

## Passkeys

The entitlement is `webcredentials:verder.vanderpoel.pro?mode=developer`. In developer
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
