# Language Practice — macOS Desktop App

An Electron shell that turns the Language Practice web app into a native macOS
app. It reuses the other two repos **unchanged**:

- the Express backend (`../language-practice-backend`) runs **inside Electron's
  main process** on `127.0.0.1:47821` — no separate server to start;
- the Vue frontend (`../language-practice-frontend`) is built with a relative
  base and loaded straight into the window.

## First run

The app asks for your OpenAI API key once and stores it in
`~/Library/Application Support/Language Practice/config.json` (never inside the
app bundle). macOS will also ask for microphone access the first time you tap
Speak. Optional model overrides (`chatModel`, `transcribeModel`, `ttsModel`) can
be added to the same config.json.

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
