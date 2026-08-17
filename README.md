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
npm run dist:unsigned   # local testing on this Mac only
npm run dist            # signed + notarized, for release to other people
```

`dist:unsigned` is the old behaviour: it launches fine on this Mac, but on
anyone else's it needs a right-click → Open, and the bundle is ad-hoc signed so
it carries no proof it hasn't been altered. Use it for testing, never to ship.

### Releasing to other people

`npm run dist` signs with Hardened Runtime and notarizes. It needs two things
this repo cannot contain:

1. **A Developer ID Application certificate.** An "Apple Development"
   certificate is *not* enough — it only signs for local development and Apple
   will refuse to notarize it. Developer ID requires Apple Developer Program
   membership; create the certificate in Xcode (Settings → Accounts → Manage
   Certificates → + → Developer ID Application) so it lands in your keychain,
   where electron-builder finds it automatically.

2. **Notarization credentials**, as environment variables:

   ```bash
   export APPLE_ID="you@example.com"
   export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # appleid.apple.com
   export APPLE_TEAM_ID="ABCDE12345"                          # Membership details
   npm run dist
   ```

   Use an app-specific password, not your Apple ID password. Notarization
   uploads the build to Apple and typically takes a few minutes.

Verify the result before publishing — both commands should succeed:

```bash
spctl -a -vvv -t install "release/mac-arm64/Language Practice.app"
codesign -dv --verbose=4 "release/mac-arm64/Language Practice.app"
```

`spctl` should say *accepted / source=Notarized Developer ID*, and `codesign`
should show `Authority=Developer ID Application: ...` rather than `Signature=adhoc`.

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
