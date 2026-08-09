import { app, BrowserWindow, dialog, ipcMain, nativeTheme, session, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Fixed local port the embedded backend listens on. The frontend is built with
// VITE_API_BASE pointing here (see the sync:frontend script).
const PORT = 47821

// Smoke mode (LP_SMOKE=1): boot everything headless, print a marker, quit.
const SMOKE = !!process.env.LP_SMOKE

let mainWindow = null
let setupWindow = null

// --- Config (API key) -------------------------------------------------------
// The key lives in ~/Library/Application Support/Language Practice/config.json.
// It is never bundled into the app.
const configPath = () => path.join(app.getPath('userData'), 'config.json')

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'))
  } catch {
    return {}
  }
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch }
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2))
  return next
}

// --- Embedded backend -------------------------------------------------------
async function startBackend(apiKey) {
  process.env.OPENAI_API_KEY = apiKey
  process.env.FRONTEND_ORIGIN = '*'
  // Optional model overrides saved in config.json pass straight through.
  const cfg = readConfig()
  if (cfg.chatModel) process.env.CHAT_MODEL = cfg.chatModel
  if (cfg.transcribeModel) process.env.TRANSCRIBE_MODEL = cfg.transcribeModel
  if (cfg.ttsModel) process.env.TTS_MODEL = cfg.ttsModel

  // The backend writes uploaded audio to a relative uploads/ dir — point the
  // working directory at userData so everything it writes lands somewhere
  // writable (a packaged app's own directory is read-only).
  const dataDir = app.getPath('userData')
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true })
  process.chdir(dataDir)

  const { createApp } = await import(pathToFileURL(path.join(__dirname, 'backend', 'app.js')).href)
  const server = createApp().listen(PORT, '127.0.0.1')

  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
}

// --- Windows ----------------------------------------------------------------
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    show: false,
    // Match the OS so the pre-paint frame doesn't flash dark on a light theme.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1220' : '#eef1f8',
    title: 'Language Practice',
  })
  mainWindow.loadFile(path.join(__dirname, 'frontend', 'index.html'))
  mainWindow.once('ready-to-show', () => {
    if (!SMOKE) mainWindow.show()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function createSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 560,
    height: 700,
    resizable: false,
    show: true,
    backgroundColor: '#0f1220',
    title: 'Language Practice — Setup',
    webPreferences: {
      preload: path.join(__dirname, 'setup-preload.cjs'),
    },
  })
  setupWindow.loadFile(path.join(__dirname, 'setup.html'))
  setupWindow.on('closed', () => {
    setupWindow = null
  })
}

async function boot(apiKey) {
  try {
    await startBackend(apiKey)
  } catch (err) {
    if (SMOKE) {
      // No blocking dialogs in smoke mode — report and bail.
      console.error(`SMOKE_FAIL: backend did not start (port ${PORT}): ${err?.message || err}`)
      app.exit(1)
      return
    }
    dialog.showErrorBox(
      'Language Practice could not start',
      `The local server failed to start (port ${PORT}).\n\nIs another copy of Language Practice already running?\n\n${err?.message || err}`,
    )
    app.exit(1)
    return
  }
  createMainWindow()
  if (SMOKE) {
    const holdMs = Number(process.env.LP_SMOKE_MS) || 2500
    setTimeout(() => {
      console.log('SMOKE_OK: backend listening and window created')
      app.exit(0)
    }, holdMs)
  }
}

// Each setup screen sizes the window to its own content, so neither screen
// scrolls and neither is left with a pool of empty space.
ipcMain.handle('resize-setup', async (_event, height) => {
  if (!setupWindow) return
  const h = Math.max(360, Math.min(900, Math.round(Number(height) || 700)))
  // setContentSize, not setSize — the latter counts the title bar and would
  // clip the last line of the page.
  const [w] = setupWindow.getContentSize()
  setupWindow.setContentSize(w, h, true)
  setupWindow.center()
})

// Open setup links in the user's real browser, never inside the app.
ipcMain.handle('open-external', async (_event, url) => {
  const u = String(url || '')
  // Only ever hand https: URLs to the OS.
  if (/^https:\/\//i.test(u)) await shell.openExternal(u)
})

/** Cheapest-first preference for the tiny "is this account funded?" probe. */
const PROBE_PREFERENCE = [
  'gpt-4o-mini',
  'gpt-5-nano',
  'gpt-5.4-nano',
  'gpt-4.1-nano',
  'gpt-5-mini',
  'gpt-5.4-mini',
  'gpt-4o',
]

/** Pick a cheap chat model the account demonstrably has access to. */
function pickProbeModel(ids) {
  const have = new Set(ids)
  const preferred = PROBE_PREFERENCE.find((m) => have.has(m))
  if (preferred) return preferred
  // Fall back to any plain chat model, skipping specialised variants.
  return ids.find(
    (id) =>
      /^gpt-[45]/.test(id) &&
      !/(audio|realtime|tts|transcribe|search|codex|pro|image|embedding)/.test(id),
  )
}

/**
 * Confirm the account actually has credit by asking for a single token. Costs a
 * few thousandths of a cent, and it's the only way to detect an unfunded
 * account — listing models succeeds even at a $0 balance.
 *
 * Anything other than a definitive `insufficient_quota` is treated as funded:
 * rate limits and model quirks shouldn't lock someone out of their own app.
 */
async function checkFunded(key, modelIds) {
  const model = pickProbeModel(modelIds)
  if (!model) return { funded: true } // nothing safe to probe with

  // The GPT-5 family renamed the token cap; fall back if the param is rejected.
  const capParam = /^(gpt-5|o[1-9])/.test(model) ? 'max_completion_tokens' : 'max_tokens'

  const attempt = (body) =>
    fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    })

  const base = { model, messages: [{ role: 'user', content: 'hi' }] }
  let res = await attempt({ ...base, [capParam]: 1 })
  if (res.status === 400) res = await attempt(base) // param mismatch — retry plain

  if (res.ok) return { funded: true }

  let code = ''
  try {
    code = (await res.json())?.error?.code || ''
  } catch {
    /* body wasn't JSON */
  }
  return { funded: !(res.status === 429 && code === 'insufficient_quota') }
}

/**
 * Check a key before we commit to it:
 *   1. GET /v1/models   — free; catches typos and revoked keys.
 *   2. one-token chat   — costs a fraction of a cent, but is the only way to
 *      tell whether the account has credit (step 1 passes at a $0 balance).
 */
ipcMain.handle('validate-key', async (_event, key) => {
  const trimmed = String(key || '').trim()
  if (!trimmed) return { ok: false, message: 'Please paste your API key.' }
  if (!trimmed.startsWith('sk-')) {
    return { ok: false, message: "That doesn't look like an OpenAI key — they start with “sk-”." }
  }

  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${trimmed}` },
      signal: AbortSignal.timeout(15000),
    })

    if (res.status === 401) {
      return { ok: false, message: 'OpenAI rejected this key. Copy it again from the API keys page.' }
    }
    if (!res.ok && res.status !== 429) {
      return { ok: false, message: `OpenAI returned an error (${res.status}). Please try again.` }
    }

    const ids = res.ok ? ((await res.json())?.data || []).map((m) => m.id) : []
    const { funded } = await checkFunded(trimmed, ids)
    if (!funded) {
      return {
        ok: false,
        code: 'no_funds',
        message:
          'This key works, but the account has no credit yet — add funds in Billing (step 2), then try again.',
      }
    }
    return { ok: true }
  } catch {
    return {
      ok: false,
      message: "Couldn't reach OpenAI. Check your internet connection and try again.",
    }
  }
})

// First-run setup: the renderer posts the pasted key here.
ipcMain.handle('save-key', async (_event, key) => {
  const trimmed = String(key || '').trim()
  if (!trimmed) return { ok: false, message: 'Please paste your API key.' }
  writeConfig({ apiKey: trimmed })
  setupWindow?.close()
  await boot(trimmed)
  return { ok: true }
})

// --- App lifecycle ----------------------------------------------------------
// Let the practice audio play without a prior user gesture (replays etc).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

app.whenReady().then(async () => {
  // Allow the mic (getUserMedia) inside the app; macOS still shows its own
  // system microphone prompt the first time.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })

  const apiKey = process.env.OPENAI_API_KEY || readConfig().apiKey
  if (!apiKey && !SMOKE) {
    createSetupWindow()
  } else {
    await boot(apiKey || 'smoke-test-key')
  }

  app.on('activate', () => {
    if (mainWindow === null && setupWindow === null) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
