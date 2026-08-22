# Language Practice — macOS Desktop App

An Electron shell that turns the Language Practice web app into a native macOS
app. It reuses the other two repos **unchanged**:

- the Express backend (`../language-practice-backend`) runs **inside Electron's
  main process** on `127.0.0.1:47821` — no separate server to start;
- the Vue frontend (`../language-practice-frontend`) is built with a relative
  base and loaded straight into the window.

## First run

New users must complete a two-screen setup before the app will start — the
backend doesn't boot until a key is saved:

1. **Welcome** — what the app is, and its three promises: free (you pay OpenAI
   directly for usage), no ads, and no data collection.
2. **Connect your OpenAI key** — four short steps (sign in → *add credits* →
   create a secret key → paste). Links open in the real browser.

The key is checked against OpenAI's free `/v1/models` endpoint before it's
accepted, so typos and revoked keys are caught immediately instead of failing
mid-conversation. Note that listing models doesn't prove the account is funded —
which is why "add credits" is flagged **required** in the UI; an unfunded key
fails later with a clear billing message.

The key is stored in
`~/Library/Application Support/language-practice-desktop/config.json` (never
inside the app bundle), encrypted with Electron's `safeStorage` — on macOS that
wraps it with a secret held in your login Keychain, so the file alone doesn't
give the key up, and a key written in the clear by an older version is re-written
encrypted on first launch. macOS will also ask for microphone access the first
time you tap Speak. Optional model overrides (`chatModel`, `transcribeModel`,
`ttsModel`) can be added to the same config.json, in the clear — they aren't
secrets.

To see the setup flow again, quit the app and delete that config.json. You'll
also land back there in the rare case the stored key fails to decrypt — macOS
ties the wrapping secret to the app's signing identity, so it survives ordinary
updates now that builds are signed with a stable Developer ID, but a keychain
reset or a restore onto a different machine can still orphan the blob. Pasting
the key again fixes it.

## Reporting a problem

**Help → Report a Problem…** opens a GitHub issue with the app version, macOS
version and architecture already filled in. Nothing is transmitted by the app —
the user is composing the report themselves and can edit or delete any of it.

That menu replaces Electron's stock one, whose Help entry points at
electronjs.org. The other entries are standard `role`s; `editMenu` is not
optional, since it is what makes ⌘V work in the API-key field.

## Develop

```bash
npm install
npm run dev        # builds backend + frontend, copies them in, launches Electron
```

`npm run sync` refreshes the copied `backend/` and `frontend/` artifacts after
you change either repo. `npm run smoke` boots everything headless and exits
(used as a sanity check).

## Build the app

```bash
npm run dist
```

The DMG lands in `~/builds/language-practice.noindex/`. Both parts of that path
are deliberate.

The `.noindex` suffix keeps Spotlight out. Every build writes an unpacked
`Language Practice.app` next to the DMG, and Spotlight indexes it as an
application — so searching for the app offers the build output alongside the
installed copy, and picking the wrong one launches a stale build. Spotlight skips
any directory whose name ends in `.noindex`, which is the mechanism that works
here. A `.metadata_never_index` file does not: it is only honoured at a volume
root, so dropping one in a subdirectory looks like a fix and silently does
nothing.

The location is outside `~/Desktop` — which iCloud Drive syncs. iCloud stamps files it syncs with
`com.apple.fileprovider.fpfs#P`, and `codesign` refuses any file carrying that
kind of attribute. Clearing the attributes before signing does not fix it:
signing walks a couple of hundred files over several minutes, and iCloud
re-stamps the freshly written output while that is still going. Building outside
the synced tree removes the race rather than fighting it. The path lives in
`directories.output`; electron-builder expands `${env.HOME}` itself, so it needs
no shell wrapper.

### How this build is signed

The app is signed with a **Developer ID Application** certificate and notarized
by Apple, so it opens on a double-click with no security warning. Both the `.app`
and the DMG carry stapled notarization tickets, which means the check also passes
offline or behind a firewall, where macOS cannot reach Apple to ask.

Verify any build before shipping it:

```bash
APP="$HOME/builds/language-practice.noindex/mac-universal/Language Practice.app"
spctl -a -vvv -t exec "$APP"     # accepted, source=Notarized Developer ID
xcrun stapler validate "$APP"    # The validate action worked!
```

Two things in `build/after-pack.cjs` still run before electron-builder signs.
It clears extended attributes off the packed bundle, because the sources are
copied in from an iCloud-synced tree and `codesign` refuses any file carrying
`com.apple.fileprovider.fpfs#P`. And it deletes
`NSAppTransportSecurity.NSAllowsArbitraryLoads`, which electron-builder writes
into every macOS build — it turns ATS off for every host, when the explicit
127.0.0.1 and localhost exceptions it writes alongside are all this app needs.
That one cannot be done through `mac.extendInfo`, which is merged before the
flag is set.

The build is **universal** (arm64 + x86_64), so one DMG serves both Apple
Silicon and Intel Macs. It is about twice the size of a single-architecture
build, since Electron's framework is included for each.

App code is packed into `app.asar`. That is electron-builder's default; this
project had it off from the initial scaffold, with no reason recorded. Turning it
on takes the bundle from ~2050 files to ~270, and a full signed-and-notarized
build from over ten minutes to about three — codesign hashes and timestamps every
file it seals, so the file count is the cost. It also gets Electron to record an
`ElectronAsarIntegrity` hash in `Info.plist` and check the archive against it at
load, which loose files have no equivalent of.

The thing to watch if this is ever changed back or extended: `main.js` reaches
the backend with a dynamic ESM `import()`, and Node's ESM loader has not always
gone through Electron's asar filesystem shim. It resolves correctly on Electron
43 — `npm run smoke` covers it, since the backend cannot start unless every
route module loaded out of the archive.

### Hardening that is off by default

Electron ships several capabilities enabled that a shipped app has no use for.
They are switched off through `build.electronFuses`, which rewrites flags in the
Electron binary at package time:

| Fuse | Why |
| --- | --- |
| `runAsNode: false` | Without it, `ELECTRON_RUN_AS_NODE=1 "Language Practice" -e '...'` runs arbitrary JavaScript — under this app's signature, notarization, and TCC grants, microphone included. That makes a notarized app a convenient launcher for anything already on the machine. |
| `enableNodeOptionsEnvironmentVariable: false` | Same escape via `NODE_OPTIONS=--require ...`. |
| `enableNodeCliInspectArguments: false` | Stops `--inspect` attaching a debugger to the main process, which can read the API key out of memory. |
| `enableEmbeddedAsarIntegrityValidation: true` | Makes Electron check `app.asar` against the `ElectronAsarIntegrity` hash in Info.plist rather than merely recording it. |
| `onlyLoadAppFromAsar: true` | Refuses to fall back to a loose `Resources/app` directory, so the check above cannot be sidestepped by swapping one in. |
| `enableCookieEncryption: true` | Encrypts the cookie store at rest. |

Order matters, and electron-builder gets it right: fuses are flipped *before*
signing. They rewrite the binary, and on Apple Silicon a modified binary whose
signature no longer matches is killed by the kernel at launch — silently, with
exit 137 and no output. If a build ever dies that way, check `codesign -v`
before looking anywhere else.

The renderer also carries a Content-Security-Policy, set in the frontend repo's
`index.html`. `connect-src` is the one that earns its keep: it names the loopback
API and nothing else, so script that somehow reached the renderer could not send
anything out. Playback needs `media-src blob:` (TTS audio arrives as a blob URL)
and Vue's `:style` bindings need `style-src 'unsafe-inline'`. `frame-ancestors`
is deliberately absent — it is ignored in a `<meta>` tag and only works as a
header.

Navigation is locked down in `main.js`: every window denies `setWindowOpenHandler`
(sending `https:` links to the real browser instead), blocks `will-navigate` away
from the page it loaded, and refuses webview attachment. The renderer holds the
IPC bridge to the API key, so nothing should be able to point it somewhere else.

### The signing setup (reference)

This is how the Developer ID signing above was set up, kept because the
certificate expires and this is what renewing it looks like. Nothing here needs
doing again for a routine release — `npm run dist` handles those.

Why a real certificate rather than an ad-hoc signature, beyond the Gatekeeper
warning: the stored API key is encrypted through `safeStorage`, whose secret
lives in a keychain entry, and macOS decides whether to hand that entry over by
matching the app against the requirement recorded when the entry was created.

```bash
codesign -d -r- "$HOME/builds/language-practice.noindex/mac-universal/Language Practice.app"
# ad-hoc:       designated => cdhash H"00783213..."          <- changes every build
# Developer ID: designated => identifier "com.pranav.languagepractice" and ...
#                             certificate leaf[subject.OU] = "P76Y6GBY23"
```

An ad-hoc signature has no identity to record, so the requirement is the
bundle's literal `cdhash` — which changes on every build, making each update
read as a different app and prompting the user for their login password once. A
Developer ID requirement names the identity instead, so it holds across
versions.

#### 1. Enrol in the Apple Developer Program ($99/year)

Apple issues **Developer ID Application** certificates only to paid members.
The `Apple Development` certificate already in this keychain is not a substitute
— it signs for local development, and Apple refuses to notarize anything signed
with it.

Before starting, the Apple Account being enrolled needs two-factor
authentication turned on and the **legal** name in its first/last name fields:
Apple verifies that name against government photo ID, and it becomes the seller
name attached to anything published. Enrol as an **Individual** unless there is
a real company to enrol — Organization enrolment additionally requires a D-U-N-S
number and takes considerably longer.

The quickest route is the **Apple Developer app on an iPhone or iPad**, which
carries the identity-verification step; the web flow at
<https://developer.apple.com/programs/enroll/> works too. Expect to supply a
government photo ID, a phone number, and a physical address — P.O. boxes are
rejected. Approval usually lands within a day or two.

Once approved, copy the **Team ID** (a ten-character string) from Membership
details in the developer account. It is needed twice below.

#### 2. Create the Developer ID Application certificate

In Xcode: **Settings → Accounts →** select the Apple ID **→ Manage Certificates
→ + → Developer ID Application**. It lands in the login keychain, where
electron-builder finds it with no configuration. Only the Account Holder can
create one, which for an Individual enrolment is you.

Confirm it arrived:

```bash
security find-identity -v -p codesigning     # expect a "Developer ID Application: ..." line
```

**Back the certificate up before going further.** In Keychain Access, find the
certificate, expand it to reveal the private key, select both, right-click →
Export, and save the `.p12` somewhere safe. Apple caps how many Developer ID
certificates an account may hold, and the private key cannot be recovered — lose
it and updates get signed with a different identity than the copies already
installed on people's machines.

#### 3. Store notarization credentials

Notarization uploads each build to Apple for an automated malware scan.
electron-builder accepts credentials three ways and checks for them in this
order — Apple ID, then API key, then keychain profile
(`app-builder-lib/out/mac/MacTargetHelper.js`, `getNotarizeOptions`).

The keychain profile is the one to use: it keeps the secret out of the
environment and out of shell history, and `notarytool` validates it immediately
rather than at the end of a ten-minute build.

```bash
# Create an app-specific password at appleid.apple.com → Sign-In and Security,
# then hand it to notarytool once. It is stored in the keychain from then on.
xcrun notarytool store-credentials "language-practice" \
  --apple-id "you@example.com" \
  --team-id "ABCDE12345" \
  --password "xxxx-xxxx-xxxx-xxxx"

export APPLE_KEYCHAIN_PROFILE="language-practice"
```

The alternative, if you would rather pass credentials per-build, is
`APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` as environment
variables. Use an app-specific password either way, never the Apple ID password.

#### 4. Point the build at it

Already done, and recorded here so a future change is legible. In `package.json`
the `mac` block carries no `identity` and no `hardenedRuntime` — electron-builder
discovers the certificate itself, and treats Hardened Runtime as on for non-MAS
builds unless explicitly disabled — plus `"notarize": true`. `build/after-pack.cjs`
does *not* ad-hoc sign; it only clears extended attributes and strips the blanket
ATS flag, both of which must happen before signing.

Then `npm run dist`, with the keychain profile named so notarization can
authenticate:

```bash
APPLE_KEYCHAIN_PROFILE="language-practice" npm run dist
```

#### 5. Check that notarization actually happened

Watch the build log for `notarization successful`. This matters more than it
looks: when electron-builder finds no credentials it logs
`skipped macOS notarization` as a **warning and carries on**, producing a signed
but un-notarized DMG that looks like a success. The exit code will not tell you.

Then verify the app itself:

```bash
APP="$HOME/builds/language-practice.noindex/mac-universal/Language Practice.app"
spctl -a -vvv -t install "$APP"     # accepted, source=Notarized Developer ID
codesign -dv --verbose=4 "$APP"     # Authority=Developer ID Application: ...
xcrun stapler validate "$APP"       # The validate action worked!
```

`stapler validate` is the one that proves the notarization ticket was attached
to the bundle rather than merely issued. @electron/notarize staples
automatically after a successful submission, so this should already pass.

An ad-hoc build, by contrast, gives `rejected` from `spctl` and
`Signature=adhoc` from `codesign` — worth recognising if signing ever silently
falls back.

#### 6. Notarize the disk image too

electron-builder notarizes and staples the `.app`, then wraps the stapled app in
a DMG — it does not submit the DMG itself. The DMG is the file people actually
download and quarantine, so submit it as well. It is quick, since Apple has
already scanned the contents.

`build.dmg.sign` is set to `true` so the DMG arrives signed; electron-builder
defaults it to `false`, and an unsigned DMG gives `spctl` nothing to evaluate —
`rejected / source=no usable signature` — even when its notarization ticket is
stapled. Sign, then notarize, then staple, in that order:

```bash
DMG="$HOME/builds/language-practice.noindex/Language Practice-1.0.0-universal.dmg"
xcrun notarytool submit "$DMG" --keychain-profile "language-practice" --wait
xcrun stapler staple "$DMG"
```

Stapling matters most for the case where someone opens the DMG offline or behind
a firewall: without a stapled ticket macOS has to reach Apple to check, and if it
cannot, it blocks.

#### 7. Ship it

```bash
cd ../language-practice-site && ./release.sh && ./deploy.sh
```

`release.sh` uploads the DMG under the fixed name in `site.config.sh`, so the
site's download button — which points at `/releases/latest/download/<asset>` —
keeps working without a redeploy. `deploy.sh` is only needed when the page copy
or the displayed version and size change. If an existing release's notes need
correcting, `gh release edit v1.0.0 --notes-file`.

The Gatekeeper workarounds that used to live in `release.sh`'s install notes and
in an `id="first-launch"` section of the site have been removed: a notarized app
opens on a double-click, so the instructions would have been actively wrong.

Entitlements live in `build/entitlements.mac.plist`. Hardened Runtime blocks
things Electron needs, so each entry there is required — including
`device.audio-input`, without which the microphone fails even though
Info.plist already declares `NSMicrophoneUsageDescription`.

## How it fits together

```
Electron main process
├─ reads API key from config.json (first-run prompt if missing)
├─ generates a random per-launch auth token (never written to disk)
├─ chdir → ~/Library/Application Support/Language Practice  (writable uploads/)
├─ imports backend/app.js  → createApp().listen(47821)   [requires the token]
└─ BrowserWindow ← frontend/index.html   [receives the token via preload]
```

### Why the backend needs a token

Binding to `127.0.0.1` keeps the port off the network, but it is not access
control: any program on the machine can reach a loopback port, and that includes
any web page in any browser. Every `/api` route spends the user's OpenAI credit,
so a page the user happened to be visiting could otherwise have driven the whole
API on their bill.

So the main process generates a 32-byte token each launch, passes it to the
backend as `LP_AUTH_TOKEN`, and hands it to its own renderer through the
preload. The backend rejects any `/api` request that can't present it in the
`X-LP-Token` header. The header is a custom one, so a cross-origin caller also
has to clear a CORS preflight it cannot satisfy.

When `LP_AUTH_TOKEN` is unset — a plain `npm run dev` against a browser — the
gate stays open, so the web dev workflow is unchanged.

Everything else — conversations, streaming, flashcards, review, recaps — is the
same code as the web app; the browser's `localStorage` maps to the app's own
profile, so desktop data is independent from your web-tab data.
