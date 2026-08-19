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
also land back there if the stored key ever fails to decrypt: this build is
ad-hoc signed, and macOS ties the wrapping secret to the signature, so a
reinstall can leave a blob the new copy can't open. Pasting the key again fixes
it.

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

The DMG lands in `~/builds/language-practice/`, deliberately outside `~/Desktop`
— which iCloud Drive syncs. iCloud stamps files it syncs with
`com.apple.fileprovider.fpfs#P`, and `codesign` refuses any file carrying that
kind of attribute. Clearing the attributes before signing does not fix it:
signing walks a couple of hundred files over several minutes, and iCloud
re-stamps the freshly written output while that is still going. Building outside
the synced tree removes the race rather than fighting it. The path lives in
`directories.output`; electron-builder expands `${env.HOME}` itself, so it needs
no shell wrapper.

### What this build is, and isn't

The app is **ad-hoc signed and not notarized**. An ad-hoc signature seals the
bundle against later tampering; it says nothing about who built it, and Apple
has not scanned it. So on any Mac that downloaded it, the first launch is
blocked with "Apple could not verify ... is free of malware", offering only
*Move to Trash* or *Done*.

The way through is **System Settings → Privacy & Security → Open Anyway**, which
appears there only after the launch has been attempted and blocked once.
Right-clicking the app and choosing Open — the old advice — stopped working in
macOS 15; Apple removed that shortcut. The install steps in `release.sh`'s
release notes and the site's "First launch" section both describe the current
flow, and all three need updating together.

Worth knowing which dialog is which, since they look similar and mean opposite
things. "Could not verify ... free of malware" means unnotarized, and Open
Anyway will get past it. "...is damaged and can't be opened" means the signature
itself is broken, there is no way past it, and it is what this build would show
without the ad-hoc signing step below.

The ad-hoc signature comes from `build/after-pack.cjs`, not from
electron-builder. With `mac.identity` set to `null`, electron-builder skips
signing altogether — it does not fall back to ad-hoc. What is left is the
linker-signed stub Electron ships upstream, whose seal no longer matches a
bundle we have renamed and added files to, and Apple Silicon refuses to launch
that. The same hook clears extended attributes off the packed bundle first,
since the files copied in still arrive carrying iCloud's stamps from the source
tree.

### Releasing to other people (needs a paid Apple Developer account)

This is the path from today's ad-hoc build to one that opens by double-clicking
on anyone's Mac. Budget a couple of days: the enrolment is the slow part, and
everything after it is an afternoon.

It fixes a second thing besides the Gatekeeper warning. The stored API key is
encrypted through `safeStorage`, which keeps its secret in a keychain entry, and
macOS decides whether to hand that entry over by matching the app against the
requirement recorded when the entry was created. An ad-hoc signature has no
identity to record, so the requirement is the literal `cdhash` of the bundle —
which changes on every single build:

```bash
codesign -d -r- "$HOME/builds/language-practice/mac-arm64/Language Practice.app"
# ad-hoc:       designated => cdhash H"00783213..."
# Developer ID: designated => identifier "com.pranav.languagepractice" and ...
#                             certificate leaf[subject.OU] = "ABCDE12345"
```

So every update currently reads as a *different app* to the keychain, and each
one makes users answer a "Language Practice wants to use your confidential
information" password prompt once. A Developer ID requirement names the identity
instead of the contents, so it holds across versions and the prompt stops.

Note that the switch itself changes the app's identity one last time, so the
first Developer ID build prompts existing users once more. After that it is
stable for as long as the certificate is — which is the other reason step 2
insists on backing the private key up.

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

#### 4. Flip the build over

1. In `package.json`, delete `"identity": null` and `"hardenedRuntime": false`
   from the `mac` block, and set `"notarize": true`. Deleting rather than
   inverting `hardenedRuntime` is deliberate: for non-MAS builds electron-builder
   already treats it as on unless explicitly set to `false`. The entitlements are
   wired up already and are read only when signing actually happens.
2. Delete **only** the `codesign` call from `build/after-pack.cjs`.
   electron-builder signs properly from here on, and an ad-hoc signature applied
   first would just be overwritten. Keep the other two steps: the `xattr` call is
   what makes signing possible at all from a source tree inside iCloud, and the
   `plutil` call strips the blanket `NSAllowsArbitraryLoads` that electron-builder
   writes into every macOS build. Both still need to run before signing, which is
   where afterPack sits either way.
3. `npm run dist`.

#### 5. Check that notarization actually happened

Watch the build log for `notarization successful`. This matters more than it
looks: when electron-builder finds no credentials it logs
`skipped macOS notarization` as a **warning and carries on**, producing a signed
but un-notarized DMG that looks like a success. The exit code will not tell you.

Then verify the app itself:

```bash
APP="$HOME/builds/language-practice/mac-arm64/Language Practice.app"
spctl -a -vvv -t install "$APP"     # accepted, source=Notarized Developer ID
codesign -dv --verbose=4 "$APP"     # Authority=Developer ID Application: ...
xcrun stapler validate "$APP"       # The validate action worked!
```

`stapler validate` is the one that proves the notarization ticket was attached
to the bundle rather than merely issued. @electron/notarize staples
automatically after a successful submission, so this should already pass.

For comparison, today's ad-hoc build gives `rejected` from `spctl` and
`Signature=adhoc` from `codesign`. That is the expected result for it, not a
regression.

#### 6. Notarize the disk image too

electron-builder notarizes and staples the `.app`, then wraps the stapled app in
a DMG — it does not submit the DMG itself. The DMG is the file people actually
download and quarantine, so submit it as well. It is quick, since Apple has
already scanned the contents:

```bash
DMG="$HOME/builds/language-practice/Language Practice-1.0.0-arm64.dmg"
xcrun notarytool submit "$DMG" --keychain-profile "language-practice" --wait
xcrun stapler staple "$DMG"
```

Stapling matters most for the case where someone opens the DMG offline or behind
a firewall: without a stapled ticket macOS has to reach Apple to check, and if it
cannot, it blocks.

#### 7. Ship it

```bash
cd ../language-practice-site && ./release.sh
```

Then undo the Gatekeeper workarounds, which are no longer true — a notarized app
opens on a double-click:

- the `### Install` notes in `release.sh` (steps 2 and 3 become unnecessary),
- the `<section id="first-launch">` block in the site's `index.html`, which is
  marked with a comment saying to remove it at exactly this point,
- the "What this build is, and isn't" section above.

Then `./deploy.sh`, and re-run `gh release edit v1.0.0 --notes-file` if the notes
for an existing release need correcting.

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
