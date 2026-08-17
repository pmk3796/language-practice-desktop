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
inside the app bundle). macOS will also ask for microphone access the first time
you tap Speak. Optional model overrides (`chatModel`, `transcribeModel`,
`ttsModel`) can be added to the same config.json.

To see the setup flow again, quit the app and delete that config.json.

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

Notarized distribution outside the App Store requires a **Developer ID
Application** certificate. The `Apple Development` certificate in this keychain
is *not* enough — it signs for local development only, and Apple will refuse to
notarize anything signed with it. Developer ID comes with Apple Developer
Program membership ($99/year); create the certificate in Xcode (Settings →
Accounts → Manage Certificates → + → Developer ID Application) so it lands in
the keychain, where electron-builder finds it automatically.

With that in hand, switch the build over:

1. In `package.json`, drop `"identity": null` and set `"hardenedRuntime": true`
   and `"notarize": true`. The entitlements are already wired up and are only
   read when signing actually happens.
2. Drop the `codesign` call from `build/after-pack.cjs` — electron-builder will
   sign properly at that point. Keep the `xattr` call; it is what makes signing
   possible at all from a source tree inside iCloud.
3. Export notarization credentials:

   ```bash
   export APPLE_ID="you@example.com"
   export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # appleid.apple.com
   export APPLE_TEAM_ID="ABCDE12345"                          # Membership details
   npm run dist
   ```

   Use an app-specific password, not your Apple ID password. Notarization
   uploads the build to Apple and typically takes a few minutes.

Verify the result before publishing:

```bash
spctl -a -vvv -t install "$HOME/builds/language-practice/mac-arm64/Language Practice.app"
codesign -dv --verbose=4 "$HOME/builds/language-practice/mac-arm64/Language Practice.app"
```

`spctl` should say *accepted / source=Notarized Developer ID*, and `codesign`
should show `Authority=Developer ID Application: ...` rather than
`Signature=adhoc`. On today's ad-hoc build, `spctl` rejects it and `codesign`
reports `Signature=adhoc` — that is the expected result, not a regression.

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
