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
npm run dist       # produces release/Language Practice-<version>-arm64.dmg
```

The build is unsigned (personal use). Because it's built locally it launches
without Gatekeeper complaints on this Mac; if you copy it to another Mac you'll
need to right-click → Open the first time, or sign/notarize it.

## How it fits together

```
Electron main process
├─ reads API key from config.json (first-run prompt if missing)
├─ chdir → ~/Library/Application Support/Language Practice  (writable uploads/)
├─ imports backend/app.js  → createApp().listen(47821)
└─ BrowserWindow ← frontend/index.html (built with VITE_API_BASE=127.0.0.1:47821)
```

Everything else — conversations, streaming, flashcards, review, recaps — is the
same code as the web app; the browser's `localStorage` maps to the app's own
profile, so desktop data is independent from your web-tab data.
