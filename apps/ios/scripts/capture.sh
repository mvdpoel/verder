#!/usr/bin/env bash
# Screenshot one screen of the app on the synthetic dataset, in the simulator.
#   scripts/capture.sh <fixture> <tab|route> <out.png> [--locked] [--scans] [--scrolled]
#                      [--text-size <size>] [--queue <preset>] [--camera <state>] [--scan <state>]
#                      [--press <text>] [--geld <state>] [--faceid <asking|idle>]
#                      [--push <denied|notDetermined>] [--more <signout|savefail>]
#                      [--timeline <state[,state…]>] [--tap <label>]
#                      [--signin <state>] [--cover] [--mic <notDetermined|denied>]
#                      [--voorjou <state[,state…]>] [--swipe <text>:<left|right>]
#                      [--proposal <state>] [--detail <state>] [--dossier <state[,state…]>]
#                      [--voice <state>] [--notify <state>]
#
#   fixture  a folder in Grip/FixtureData (voorjou-few, voorjou-many, voorjou-long,
#            voorjou-laden (the skeleton on the voorjou-* clock), voorjou-selecteren,
#            empty, offline, unauthorized, calm, one-item, loading, server-error,
#            server-error-cached, offline-cached, money-complete, money-partial,
#            money-geen-data, money-empty, money-no-account, money-unrecognised,
#            detail, detail-na-vraag (after the question is answered), detail-fout,
#            detail-offline, detail-verlopen,
#            money-no-budget, money-overspent, dossier, timeline, weekly, weekly-rustig,
#            weekly-tweede, weekly-eerste, weekly-loading, weekly-offline-kept,
#            weekly-offline-missing, weekly-fout, voice, voice-offline, voice-verlopen,
#            voice-te-groot, voice-geen-partijen, voice-partijen-fout, voice-verstuurd)
#   tab      overzicht | voorjou | scan | dossier | meer
#   share:<scene>  the share extension's screen, hosted in a sheet on a real
#            ShareModel (Fixtures/FixtureShareHost.swift; "share · final"):
#            deelblad (the system share sheet) laden laden-fout een-pdf
#            een-pdf-lang (the SE frame's long name) fotos meerdere
#            meerdere-deels meer-dan-10 versturen versturen-fout verstuurd
#            bewaard-offline bewaard-groot niet-ingelogd bewaard
#            niet-ondersteund te-groot; with --scrolled, opened at its end
#   route    proposal:<id> | suggestion:<id> | task:<id> | document:<id> | geld | weekly | timeline | voice
#            | meer:account | meer:notifications | meer:widgets | meer:about | meer:developer
#            (a Meer screen pushed onto the Meer stack, as its row's tap does)
#            | widget:<scene> — the widget faces on a DRAWN home screen, lock screen,
#            Today View or StandBy (FixtureWidgetHost; the simulator cannot be told
#            to place a widget from the shell): thuis-{volle-kleur,getint,helder,leeg,
#            leeg-getint,een-item,verouderd,afgemeld} groot-{volle-kleur,getint,helder,
#            leeg,verouderd,afgemeld} vandaag-vergrendeld toegang-{wacht,een-item,leeg,
#            verouderd,afgemeld} standby-{ontgrendeld,vergrendeld,nacht,leeg,verouderd,
#            afgemeld}. StandBy is landscape: drawn turned a quarter, the PNG is turned
#            back. With DEVICE="iPhone SE (3rd generation)" for the SE frame and
#            --text-size ax5 for the AX5 frames.
#   --locked keep the app lock closed (Overzicht's counts-only glance)
#   --scans  the phone's upload queue holds today's scans (2 sent, 1 waiting)
#   --scrolled  open Overzicht scrolled to its end (the lower half of a
#            "hele pagina" frame); --scroll <waiting|leefgeld|rest|end> to a card
#            (waiting: the end of Wacht op jou, at the bottom of the screen).
#            On the Weekoverzicht: end, or middle (the chart; at AX sizes the live card).
#            On Meer and its screens: end (the column's end) or middle (the
#            screen's middle anchor: Account's Toegangssleutel group at the top)
#   --push   the notification permission: denied | notDetermined (default: allowed)
#   --more   a Meer state only a gesture reaches: signout (Account's Uitloggen
#            sheet up) | savefail (a Meldingen switch moved and its save failed;
#            fixture meer-save-fails)
#   --text-size  the simulator's Dynamic Type size for this shot, as simctl
#            spells it (e.g. accessibility-extra-extra-extra-large for AX5,
#            large for the default); the previous size is put back afterwards.
#            "ax5" is accepted for accessibility-extra-extra-extra-large
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
#   --faceid idle    with --locked: the glance at rest — the automatic prompt counted as
#            asked and nothing cancelled, so "Toon details" stands with its footnote
#   --faceid asking  with --locked: the automatic Face ID prompt never answers,
#            so Overzicht holds "Face ID vraagt" (no button)
#   --faceid nopasscode  with --locked: the phone has no passcode ("Zet eerst een
#            toegangscode aan"). Plain --locked (no --faceid) cancels the automatic
#            prompt: the "Ontgrendel je dossier" sheet
#   --signin a sign-in state ("auth · final", Sign-in row): default keyboard busy
#            cancelled no-passkey wrong-password rate-limited server not-on-account
#            expired offline offer already-on (the last two are signed in)
#   --push-preprompt  notifications never asked: the "Meldingen" pre-prompt shows
#   --cover  the app-switcher privacy cover, as the scene going inactive draws it
#   --mic    the microphone permission, with the voice log open over the tab:
#            notDetermined (its pre-prompt) | denied ("microfoon uit")
#   --timeline  the Tijdlijn in a state only a gesture reaches (route timeline,
#            or tab overzicht with "overzicht"): verborgen | sheet | end |
#            overzicht | dicht (the raised sheet closed again) |
#            scroll:<stop id> | stop:<stop id>, comma-separated
#   --voorjou  Voor jou in a state only a gesture reaches (tab voorjou):
#            toast | twee | nietopgeslagen | selecteren | bevestigen | gedaan |
#            ongedaan | scroll:<row key|done|more>[@<y>], comma-separated
#            (@<y>: the row's point y — 0 top, 1 bottom — on the same point
#            of the visible list; without it the row's top is at the top)
#   --proposal  the proposal screen (route proposal:<id>) in a state only a
#            gesture reaches: hold faceid afgebroken aangepast editor typen goedgekeurd bron
#            weggooien afwijzen. On a proposal route, --scroll rest puts the
#            trigger card at the top (the frames' "scrolled" position),
#            middle the attachments and end the end (also in the editor),
#            waiting the AX "Versturen" section at the top
#   --detail  a question, suggestion or task screen (route proposal:, suggestion:
#            or task:) in a state only a gesture reaches: bevestigen (the
#            question's confirmation sheet) typen (its own answer typed) fout
#            (the decision posted against fixture detail-fout) veld (one field
#            being edited) datum (the deadline's wheel up) aangepast (two
#            fields changed) reden (the "Niet relevant, met reden" sheet)
#            vastgelegd (approved) nee (a question answered "Nee": Voor jou
#            with its undo toast) nietrelevant (a suggestion's one-tap "Niet
#            relevant": the same) gedaan (a task just set to gedaan, its undo
#            row up) verlopen (two fields changed and approved against
#            fixture detail-verlopen, whose approval answers 401: the
#            session expired, the screen and its edits kept in place).
#            With aangepast, --scroll middle puts the first changed field
#            at the top (the AX5 frame's Gevorderd card)
#   --dossier  Dossier (tab dossier, or a document: route) in a state only a
#            gesture reaches, comma-separated: refresh (a second sync after the
#            first — the kept copy offline, or a later delta) · filter:<soort>
#            (a chip tapped, e.g. filter:brief) · zoek:<query> (the search bar
#            up with it typed) · server ("Zoek op de server" tapped) ·
#            scroll:<documenten|chips|server|rij:<n>> (rij:<n>: the n-th row,
#            1 = the newest, first under the pinned bar) · open:<document id> (the viewer
#            pushed after the first sync) · balie · balie-zoom (the viewer's
#            "Toon aan de balie", zoomed in) · pagina (the AX5 viewer at its page)
#   --voice  the voice log ("Spraaknotitie") open over the tab, in a state of
#            the "Voice quick-log · final" frames: idle opname (held) omlaag
#            (hands-free, sheet pulled down) omzetten nietsgehoord
#            omzettenmislukt spraakuit laden ladenmislukt voorbeeld tijd tekst
#            metwie typen weggooien verstuurd nietverstuurd tegroot. The
#            fixture decides the server's part (voice-offline for
#            nietverstuurd, voice-verlopen, voice-te-groot, voice-verstuurd,
#            voice-geen-partijen / voice-partijen-fout with metwie or
#            voorbeeld); --locked with voorbeeld is "vergrendeld"
#   --swipe  drag the row whose text reads exactly <text> part-way to the
#            right (its leading action) or left (its trailing one) and shoot
#            it held open; runs through the GripCapture UI test, as --press does
#   --tap    tap the BUTTON whose accessibility label is exactly <label> and
#            shoot what it opens (the Tijdlijn's filter menu: --tap Filter);
#            runs through the GripCapture UI test, as --press does
#   --notify a notification as iOS draws it ("notifications · final"): the
#            payloads in scripts/pushes/ are sent with `xcrun simctl push` while
#            the GripCapture UI test holds the phone in place (lock screen,
#            in the app, or home screen) and presses. The app runs on <fixture>
#            (meldingen, or meldingen-offline / -verlopen / -afgerond /
#            -afgehandeld for the notices an action leads to) and asks iOS for
#            the real permission once. States:
#            verborgen (previews set to Never for the shot) verder-mail
#            creditor-mail proposal reminder follow-up follow-up-schuldeiser
#            filing system weekly stapel (follow-up, then reminder on top) se
#            (filing, then verder-mail on top) banner (verder-mail over the app)
#            badge (home screen; the fixture's waiting count — voorjou-many for 498)
#            task-due task-due-scroll (long-pressed, AX5: scrolled to Gedaan)
#            vraag vraag-scroll gedaan-notice (Gedaan chosen; the fixture
#            decides the notice) keuze-notice (an option chosen; likewise)
#   --press  long-press the text that reads exactly <text> and shoot what that
#            opens (with --scan queue: the row menu, "Wachtrij / rij-acties").
#            A simulator cannot be long-pressed from the shell, so the app is
#            launched and pressed by the GripCapture UI test instead.
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
usage() { echo "usage: scripts/capture.sh <fixture> <tab|route> <out.png> [--locked] [--scans] [--scrolled | --scroll <card>] [--text-size <size>] [--queue <preset>] [--camera <state>] [--scan <state>] [--press <text>] [--geld <state>] [--faceid <asking|idle>] [--push <state>] [--more <state>]" >&2; exit 2; }
[ $# -ge 3 ] || usage
FIXTURE="$1"; TARGET="$2"; OUT="$3"; shift 3
SIGNIN=""; COVER=""; MIC=""; PUSHPRE=""
SIGNIN_STATES="default keyboard busy cancelled no-passkey wrong-password rate-limited server not-on-account expired offline offer already-on"
LOCKED=""; SCANS=""; SCROLLED=""; TEXT_SIZE=""; QUEUE=""; CAMERA=""; SCAN_STATE=""; PRESS=""; GELD=""; FACEID=""; PUSH=""; MORE=""
TIMELINE=""; TAP=""; VOORJOU=""; SWIPE=""; PROPOSAL=""; DETAIL=""; DOSSIER=""; VOICE=""; NOTIFY=""
NOTIFY_STATES="verborgen verder-mail creditor-mail proposal reminder follow-up follow-up-schuldeiser filing system weekly stapel se banner badge task-due task-due-scroll vraag vraag-scroll gedaan-notice keuze-notice"
TEXT_SIZES="extra-small small medium large extra-large extra-extra-large extra-extra-extra-large accessibility-medium accessibility-large accessibility-extra-large accessibility-extra-extra-large accessibility-extra-extra-extra-large"
while [ $# -gt 0 ]; do
  case "$1" in
    --locked) LOCKED=1 ;;
    --scans) SCANS=1 ;;
    --scrolled) SCROLLED=end ;;
    --scroll)
      [ $# -ge 2 ] || usage
      case "$2" in waiting|leefgeld|rest|end|middle) SCROLLED="$2" ;; *) echo "capture.sh: --scroll takes waiting, leefgeld, rest, end or middle" >&2; exit 2 ;; esac
      shift ;;
    --text-size)
      [ $# -ge 2 ] || usage
      [ "$2" != ax5 ] || set -- "$1" accessibility-extra-extra-extra-large "${@:3}"
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
    --faceid)
      [ $# -ge 2 ] || usage
      case "$2" in asking|idle|nopasscode) FACEID="$2" ;; *) echo "capture.sh: --faceid takes asking, idle or nopasscode" >&2; exit 2 ;; esac
      shift ;;
    --push)
      [ $# -ge 2 ] || usage
      case "$2" in denied|notDetermined) PUSH="$2" ;; *) echo "capture.sh: --push takes denied or notDetermined" >&2; exit 2 ;; esac
      shift ;;
    --more)
      [ $# -ge 2 ] || usage
      case "$2" in signout|savefail) MORE="$2" ;; *) echo "capture.sh: --more takes signout or savefail" >&2; exit 2 ;; esac
      shift ;;
    --signin)
      [ $# -ge 2 ] || usage
      case " $SIGNIN_STATES " in *" $2 "*) SIGNIN="$2" ;; *) echo "capture.sh: --signin takes one of: $SIGNIN_STATES" >&2; exit 2 ;; esac
      shift ;;
    --cover) COVER=1 ;;
    --notify)
      [ $# -ge 2 ] || usage
      case " $NOTIFY_STATES " in *" $2 "*) NOTIFY="$2" ;; *) echo "capture.sh: --notify takes one of: $NOTIFY_STATES" >&2; exit 2 ;; esac
      shift ;;
    --push-preprompt) PUSHPRE=1 ;;
    --mic)
      [ $# -ge 2 ] || usage
      case "$2" in notDetermined|denied) MIC="$2" ;; *) echo "capture.sh: --mic takes notDetermined or denied" >&2; exit 2 ;; esac
      shift ;;
    --press)
      [ $# -ge 2 ] && [ -n "$2" ] || usage
      PRESS="$2"
      shift ;;
    --tap)
      [ $# -ge 2 ] && [ -n "$2" ] || usage
      TAP="$2"
      shift ;;
    --voorjou)
      [ $# -ge 2 ] && [ -n "$2" ] || usage
      for v in ${2//,/ }; do
        case "$v" in toast|twee|nietopgeslagen|selecteren|bevestigen|gedaan|ongedaan|scroll:?*) ;;
          *) echo "capture.sh: --voorjou takes toast, twee, nietopgeslagen, selecteren, bevestigen, gedaan, ongedaan or scroll:<key>" >&2; exit 2 ;; esac
      done
      VOORJOU="$2"
      shift ;;
    --proposal)
      [ $# -ge 2 ] || usage
      case "$2" in hold|faceid|afgebroken|aangepast|editor|typen|weggooien|afwijzen|goedgekeurd|bron) PROPOSAL="$2" ;;
        *) echo "capture.sh: --proposal takes hold, faceid, afgebroken, aangepast, editor, typen, weggooien, afwijzen, goedgekeurd or bron" >&2; exit 2 ;; esac
      shift ;;
    --detail)
      [ $# -ge 2 ] || usage
      case "$2" in bevestigen|typen|fout|veld|datum|aangepast|reden|vastgelegd|nee|nietrelevant|gedaan|verlopen) DETAIL="$2" ;;
        *) echo "capture.sh: --detail takes bevestigen, typen, fout, veld, datum, aangepast, reden, vastgelegd, nee, nietrelevant, gedaan or verlopen" >&2; exit 2 ;; esac
      shift ;;
    --voice)
      [ $# -ge 2 ] || usage
      case "$2" in idle|opname|omlaag|omzetten|nietsgehoord|omzettenmislukt|spraakuit|laden|ladenmislukt|voorbeeld|tijd|tekst|metwie|typen|weggooien|verstuurd|nietverstuurd|tegroot) VOICE="$2" ;;
        *) echo "capture.sh: --voice takes idle, opname, omlaag, omzetten, nietsgehoord, omzettenmislukt, spraakuit, laden, ladenmislukt, voorbeeld, tijd, tekst, metwie, typen, weggooien, verstuurd, nietverstuurd or tegroot" >&2; exit 2 ;; esac
      shift ;;
    --dossier)
      [ $# -ge 2 ] && [ -n "$2" ] || usage
      for d in ${2//,/ }; do
        case "$d" in refresh|server|balie|balie-zoom|pagina|filter:?*|zoek:?*|scroll:documenten|scroll:chips|scroll:server|scroll:rij:[1-9]*|open:?*) ;;
          *) echo "capture.sh: --dossier takes refresh, filter:<soort>, zoek:<query>, server, scroll:<documenten|chips|server|rij:<n>>, open:<id>, balie, balie-zoom or pagina" >&2; exit 2 ;; esac
      done
      DOSSIER="$2"
      shift ;;
    --swipe)
      [ $# -ge 2 ] || usage
      case "$2" in ?*:left|?*:right) SWIPE="$2" ;; *) echo "capture.sh: --swipe takes <text>:left or <text>:right" >&2; exit 2 ;; esac
      shift ;;
    --timeline)
      [ $# -ge 2 ] && [ -n "$2" ] || usage
      for t in ${2//,/ }; do
        case "$t" in verborgen|sheet|end|overzicht|dicht|scroll:*|stop:*) ;;
          *) echo "capture.sh: --timeline takes verborgen, sheet, end, overzicht, dicht, scroll:<id> or stop:<id>" >&2; exit 2 ;; esac
      done
      TIMELINE="$2"
      shift ;;
    *) usage ;;
  esac
  shift
done
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac

cd "$(dirname "$0")/.."
DEVICE="${DEVICE:-iPhone 17}"
BUNDLE=pro.vanderpoel.grip
[ -d "Grip/FixtureData/$FIXTURE" ] && [ "$FIXTURE" != "_shared" ] || {
  echo "capture.sh: no fixture '$FIXTURE'; known: $(ls Grip/FixtureData | grep -v '^_' | tr '\n' ' ')" >&2; exit 2; }

# The app's own grammar (FixtureLaunch.Tab, .Screen, DeepLink.parse's UUID ids),
# so a typo stops here rather than in a crashed app.
HEX='[0-9A-Fa-f]'
UUID_RE="^$HEX{8}-$HEX{4}-$HEX{4}-$HEX{4}-$HEX{12}\$"
case "$TARGET" in
  overzicht|voorjou|scan|dossier|meer) ARGS=(-tab "$TARGET") ;;
  geld|weekly|timeline|voice) ARGS=(-route "$TARGET") ;;
  meer:account|meer:notifications|meer:widgets|meer:about|meer:developer) ARGS=(-route "$TARGET") ;;
  widget:*)
    WIDGET_SCENES="thuis-volle-kleur thuis-getint thuis-helder thuis-leeg thuis-leeg-getint thuis-een-item thuis-verouderd thuis-afgemeld groot-volle-kleur groot-getint groot-helder groot-leeg groot-verouderd groot-afgemeld vandaag-vergrendeld toegang-wacht toegang-een-item toegang-leeg toegang-verouderd toegang-afgemeld standby-ontgrendeld standby-vergrendeld standby-nacht standby-leeg standby-verouderd standby-afgemeld"
    case " $WIDGET_SCENES " in *" ${TARGET#widget:} "*) ;; *) echo "capture.sh: unknown widget scene '${TARGET#widget:}'; known: $WIDGET_SCENES" >&2; exit 2 ;; esac
    ARGS=(-widget-host "${TARGET#widget:}") ;;
  share:*)
    SHARE_SCENES="deelblad laden laden-fout een-pdf een-pdf-lang fotos meerdere meerdere-deels meer-dan-10 versturen versturen-fout verstuurd bewaard-offline bewaard-groot niet-ingelogd bewaard niet-ondersteund te-groot"
    case " $SHARE_SCENES " in *" ${TARGET#share:} "*) ;; *) echo "capture.sh: unknown share scene '${TARGET#share:}'; known: $SHARE_SCENES" >&2; exit 2 ;; esac
    ARGS=(-share-host "${TARGET#share:}") ;;
  proposal:*|suggestion:*|task:*|document:*)
    if [ "${CAPTURE_UNCHECKED_TARGET:-0}" != 1 ] && ! [[ "${TARGET#*:}" =~ $UUID_RE ]]; then
      echo "capture.sh: '$TARGET' — the id after '${TARGET%%:*}:' must be a UUID" >&2; exit 2
    fi
    ARGS=(-route "$TARGET") ;;
  *)
    if [ "${CAPTURE_UNCHECKED_TARGET:-0}" != 1 ]; then
      echo "capture.sh: unknown target '$TARGET'; tabs: overzicht voorjou scan dossier meer;" \
        "routes: geld weekly timeline voice proposal:<uuid> suggestion:<uuid> task:<uuid> document:<uuid>" \
        "meer:account meer:notifications meer:widgets meer:about meer:developer" >&2; exit 2
    fi
    ARGS=(-route "$TARGET") ;;
esac
[ -z "$LOCKED" ] || ARGS+=(-fixtures-locked)
# `simctl ui content_size` alone does not reach an app launched right after it
# (measured 2026-11-03: the weekly screen drew at Large under an AX5 setting),
# so the app is also given UIKit's own launch override for the same size.
if [ -n "$TEXT_SIZE" ]; then
  case "$TEXT_SIZE" in
    extra-small) CAT=XS ;; small) CAT=S ;; medium) CAT=M ;; large) CAT=L ;; extra-large) CAT=XL ;;
    extra-extra-large) CAT=XXL ;; extra-extra-extra-large) CAT=XXXL ;;
    accessibility-medium) CAT=AccessibilityM ;; accessibility-large) CAT=AccessibilityL ;;
    accessibility-extra-large) CAT=AccessibilityXL ;; accessibility-extra-extra-large) CAT=AccessibilityXXL ;;
    accessibility-extra-extra-extra-large) CAT=AccessibilityXXXL ;;
  esac
  ARGS+=(-UIPreferredContentSizeCategoryName "UICTContentSizeCategory$CAT")
fi
[ -z "$SCANS" ] || ARGS+=(-fixtures-scans)
[ -z "$SCROLLED" ] || ARGS+=(-fixtures-scroll "$SCROLLED")
[ -z "$QUEUE" ] || ARGS+=(-fixtures-queue "$QUEUE")
[ -z "$CAMERA" ] || ARGS+=(-fixtures-camera "$CAMERA")
[ -z "$SCAN_STATE" ] || ARGS+=(-fixtures-scan "$SCAN_STATE")
[ -z "$GELD" ] || ARGS+=(-fixtures-geld "$GELD")
[ -z "$PUSH" ] || ARGS+=(-fixtures-push "$PUSH")
[ -z "$MORE" ] || ARGS+=(-fixtures-more "$MORE")
[ -z "$TIMELINE" ] || ARGS+=(-fixtures-timeline "$TIMELINE")
[ -z "$VOORJOU" ] || ARGS+=(-fixtures-voorjou "$VOORJOU")
[ -z "$PROPOSAL" ] || ARGS+=(-fixtures-proposal "$PROPOSAL")
[ -z "$DETAIL" ] || ARGS+=(-fixtures-detail "$DETAIL")
[ -z "$DOSSIER" ] || ARGS+=(-fixtures-dossier "$DOSSIER")
[ -z "$VOICE" ] || ARGS+=(-fixtures-voice "$VOICE")
[ -z "$SIGNIN" ] || ARGS+=(-fixtures-signin "$SIGNIN")
[ -z "$COVER" ] || ARGS+=(-fixtures-cover)
[ -z "$PUSHPRE" ] || ARGS+=(-fixtures-push-preprompt)
[ -z "$MIC" ] || ARGS+=(-fixtures-mic "$MIC")
GESTURES=0
for g in "$PRESS" "$TAP" "$SWIPE"; do [ -z "$g" ] || GESTURES=$((GESTURES + 1)); done
[ "$GESTURES" -le 1 ] || { echo "capture.sh: --press, --tap and --swipe are one gesture each; pick one" >&2; exit 2; }
if [ -n "$FACEID" ]; then
  [ -n "$LOCKED" ] || { echo "capture.sh: --faceid needs --locked" >&2; exit 2; }
  ARGS+=(-fixtures-faceid "$FACEID")
fi
[ "${CAPTURE_CHECK_ONLY:-0}" != 1 ] || { echo "capture.sh: arguments OK"; exit 0; }

# -F: a name such as "iPhone SE (3rd generation)" holds regex metacharacters.
UDID="$(xcrun simctl list devices available | grep -F "    $DEVICE (" | head -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')"
[ -n "$UDID" ] || { echo "capture.sh: no available simulator named '$DEVICE'" >&2; exit 1; }

if [ "${SKIP_BUILD:-0}" != 1 ]; then
  [ -f Local.xcconfig ] || { echo "capture.sh: copy Local.xcconfig.example to Local.xcconfig" >&2; exit 1; }
  xcodegen -q
  env -u NODE_ENV xcodebuild build -scheme Grip -configuration Debug \
    -destination "id=$UDID" -derivedDataPath build/DD -quiet
fi
APP=build/DD/Build/Products/Debug-iphonesimulator/Grip.app
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
if [ -n "$NOTIFY" ]; then
  # What to push, where the phone is, what to wait for, and what to press.
  SCENE=lock; PREVIEWS=""; GESTURE=none; RESULT=""; PUSHES=(); WAKE=
  case "$NOTIFY" in
    verborgen) PUSHES=(verder-mail); PREVIEWS=never ;;
    # The LAST push lands on top. The frames put what waits longest on Martin
    # first: the proposal reminder over the follow-up, the time-sensitive
    # Grip mail over the passive filing digest.
    stapel) PUSHES=(follow-up reminder) ;;
    se) PUSHES=(filing verder-mail); WAKE=1 ;;
    banner) PUSHES=(verder-mail); SCENE=app ;;
    # The simulator refuses a badge-only push ("no content that needs to
    # alert"); the app sets the badge itself from Voor jou's count (under
    # -fixtures-notify-allow only; voorjou-many draws 498).
    badge) PUSHES=(); SCENE=home ;;
    # A long press opens a BANNER (over the app): on the lock screen
    # XCUITest's press reads as the start of a swipe and only slides the row.
    task-due) PUSHES=(task-due); GESTURE=press; SCENE=app ;;
    task-due-scroll) PUSHES=(task-due); GESTURE=press-scroll; SCENE=app ;;
    vraag) PUSHES=(question); GESTURE=press; SCENE=app ;;
    vraag-scroll) PUSHES=(question); GESTURE=press-scroll; SCENE=app ;;
    gedaan-notice) PUSHES=(task-due); GESTURE="act:Gedaan"; SCENE=home ;;
    keuze-notice) PUSHES=(question); GESTURE="act:Ja, koppel hem"; SCENE=home ;;
    *) PUSHES=("$NOTIFY") ;;
  esac
  case "$NOTIFY:$FIXTURE" in
    gedaan-notice:meldingen-offline) RESULT="Gedaan kwam niet door" ;;
    gedaan-notice:meldingen-verlopen) RESULT="Opnieuw inloggen nodig" ;;
    gedaan-notice:meldingen-afgerond) RESULT="Taak al afgerond" ;;
    keuze-notice:meldingen-offline) RESULT="Keuze kwam niet door" ;;
    keuze-notice:meldingen-afgehandeld) RESULT="Vraag al afgehandeld" ;;
    gedaan-notice:*|keuze-notice:*) echo "capture.sh: --notify $NOTIFY needs a fixture whose action fails (meldingen-offline, -verlopen, -afgerond, -afgehandeld)" >&2; exit 2 ;;
  esac
  # The text the LAST push shows (its title; the placeholder when previews hide it).
  LAST=""; [ "${#PUSHES[@]}" -eq 0 ] || LAST="${PUSHES[${#PUSHES[@]}-1]}"
  WAIT=""
  [ -z "$LAST" ] || WAIT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["aps"]["alert"]["title"])' "scripts/pushes/$LAST.apns")"
  [ "$PREVIEWS" != never ] || WAIT="Nieuw bericht van Grip"
  ALL_ARGS=(-fixtures "$FIXTURE" "${ARGS[@]}" -fixtures-notify-allow)
  mkdir -p "$(dirname "$OUT")"
  rm -f "$OUT.partial.png" "$OUT.partial.png.ready"
  TEST_RUNNER_CAPTURE_ARGS="$(printf '%s\n' "${ALL_ARGS[@]}")" TEST_RUNNER_CAPTURE_SCENE="$SCENE" \
    TEST_RUNNER_CAPTURE_PREVIEWS="$PREVIEWS" TEST_RUNNER_CAPTURE_WAIT="$WAIT" \
    TEST_RUNNER_CAPTURE_GESTURE="$GESTURE" TEST_RUNNER_CAPTURE_RESULT="$RESULT" TEST_RUNNER_CAPTURE_WAKE="$WAKE" \
    TEST_RUNNER_CAPTURE_OUT="$OUT.partial.png" \
    env -u NODE_ENV xcodebuild test -scheme GripCapture -destination "id=$UDID" \
    -only-testing:GripCapture/NotificationCapture -derivedDataPath build/DD -quiet >"$OUT.log" 2>&1 &
  TEST_PID=$!
  for _ in $(seq 1 600); do
    [ -e "$OUT.partial.png.ready" ] && break
    kill -0 "$TEST_PID" 2>/dev/null || break
    sleep 1
  done
  if [ -e "$OUT.partial.png.ready" ]; then
    for p in ${PUSHES[@]+"${PUSHES[@]}"}; do
      xcrun simctl push "$UDID" "$BUNDLE" "scripts/pushes/$p.apns" >/dev/null
      sleep 1.5
    done
  fi
  wait "$TEST_PID" || { echo "capture.sh: the --notify capture failed — not writing $OUT (log: $OUT.log)." >&2; rm -f "$OUT.partial.png" "$OUT.partial.png.ready"; exit 1; }
  rm -f "$OUT.partial.png.ready" "$OUT.log"
  [ -s "$OUT.partial.png" ] || { echo "capture.sh: the --notify capture wrote no PNG." >&2; exit 1; }
  mv -f "$OUT.partial.png" "$OUT"
  echo "$OUT"
  exit 0
fi
if [ -n "$PRESS" ] || [ -n "$TAP" ] || [ -n "$SWIPE" ]; then
  # The UI test launches the app with these arguments, presses, and writes
  # the PNG itself; it fails (and writes nothing) if the text is not on screen.
  ALL_ARGS=(-fixtures "$FIXTURE" "${ARGS[@]}")
  mkdir -p "$(dirname "$OUT")"
  rm -f "$OUT.partial.png"
  TEST_RUNNER_CAPTURE_ARGS="$(printf '%s\n' "${ALL_ARGS[@]}")" TEST_RUNNER_CAPTURE_PRESS="$PRESS" \
    TEST_RUNNER_CAPTURE_TAP="$TAP" TEST_RUNNER_CAPTURE_SWIPE="$SWIPE" \
    TEST_RUNNER_CAPTURE_OUT="$OUT.partial.png" \
    env -u NODE_ENV xcodebuild test -scheme GripCapture -destination "id=$UDID" \
    -derivedDataPath build/DD -quiet >/dev/null \
    || { echo "capture.sh: the --press/--tap/--swipe capture failed — not writing $OUT." >&2; rm -f "$OUT.partial.png"; exit 1; }
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
  echo "  xcrun simctl spawn $UDID log show --last 2m --predicate 'process == \"Grip\"'" >&2
  exit 1
}
DEFAULT_SETTLE=3
grep -q '"thenFail"' "Grip/FixtureData/$FIXTURE/fixture.json" && DEFAULT_SETTLE=68
sleep "${SETTLE:-$DEFAULT_SETTLE}"
alive || died "before the screenshot"
mkdir -p "$(dirname "$OUT")"
TMP="$OUT.partial.png"
trap 'rm -f "$TMP"; restore_size' EXIT
xcrun simctl io "$UDID" screenshot --type=png "$TMP" >/dev/null 2>&1
alive || died "during the screenshot"
# StandBy is drawn turned a quarter counter-clockwise; turn the PNG back.
case "$TARGET" in widget:standby-*) sips -r 90 "$TMP" >/dev/null ;; esac
mv -f "$TMP" "$OUT"
echo "$OUT"
