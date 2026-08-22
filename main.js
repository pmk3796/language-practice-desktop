import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, safeStorage, session, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Fixed local port the embedded backend listens on. The frontend is built with
// VITE_API_BASE pointing here (see the sync:frontend script).
const PORT = 47821

// Shared secret for the embedded backend, regenerated every launch and never
// written to disk. Binding to 127.0.0.1 keeps the port off the network but does
// nothing about other programs on this machine — in particular, any web page in
// any browser can POST to a loopback port. Every /api route spends the user's
// OpenAI credit, so the backend requires this token and only our own renderer
// is ever given it.
const AUTH_TOKEN = crypto.randomBytes(32).toString('hex')

// Smoke mode (LP_SMOKE=1): boot everything headless, print a marker, quit.
const SMOKE = !!process.env.LP_SMOKE

let mainWindow = null
let setupWindow = null
let openaiService = null

// --- Config (API key) -------------------------------------------------------
// Settings live in config.json under the app's userData directory
// (~/Library/Application Support/language-practice-desktop), and the key is
// never bundled into the app. Nor is it written to that file in the clear: it
// goes through safeStorage, which on macOS wraps it with a secret held in the
// login Keychain, so the file on its own is not enough to read the key back.
const configPath = () => path.join(app.getPath('userData'), 'config.json')

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'))
  } catch {
    return {}
  }
}

function saveConfig(next) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  // 0600 because the fallback in writeApiKey can still put a key in here, and
  // because none of it is another account's business either way. The mode
  // option only applies when the file is created, so rewrites are chmod'ed.
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), { mode: 0o600 })
  fs.chmodSync(configPath(), 0o600)
  return next
}

/**
 * The stored key, decrypted, or null if there isn't a usable one.
 *
 * Ciphertext that won't decrypt counts as "no key". macOS ties the wrapping
 * secret to the app's code signature, and an ad-hoc signature changes on every
 * rebuild, so a reinstall can leave a blob this build can't open. Falling back
 * to setup costs the user one paste and always works; booting with a key that
 * cannot be read would fail later and less clearly.
 */
function readApiKey() {
  const cfg = readConfig()
  if (cfg.apiKeyEnc) {
    try {
      return safeStorage.decryptString(Buffer.from(cfg.apiKeyEnc, 'base64')) || null
    } catch {
      return null
    }
  }
  // Plaintext: either written before this app encrypted anything, or by the
  // fallback in writeApiKey.
  return cfg.apiKey || null
}

/**
 * Store the key encrypted, removing any plaintext copy an older version left.
 * If the OS won't encrypt, keep the old plaintext behaviour rather than locking
 * someone out of their own app — the file is 0600 in both cases.
 *
 * The encrypt call is guarded as well as the availability check: this build is
 * ad-hoc signed, so macOS asks before letting it read its own Safe Storage
 * keychain entry, and a user who answers Deny lands here with encryption still
 * reported as available but the call itself failing. Saving the key must not be
 * what breaks in that case — otherwise Deny leaves setup with no way forward.
 *
 * Must be called after `app.whenReady()`: safeStorage isn't usable before it.
 */
function writeApiKey(key) {
  const next = { ...readConfig() }
  delete next.apiKey
  delete next.apiKeyEnc

  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('encryption unavailable')
    next.apiKeyEnc = safeStorage.encryptString(key).toString('base64')
  } catch {
    // encryptString throws before assigning, so apiKeyEnc is still absent here.
    next.apiKey = key
  }
  saveConfig(next)
}

// --- Embedded backend -------------------------------------------------------
async function startBackend(apiKey) {
  process.env.OPENAI_API_KEY = apiKey
  process.env.LP_AUTH_TOKEN = AUTH_TOKEN
  // The renderer loads over file://, so its Origin is the opaque value `null`.
  // Naming it exactly (rather than the old '*', which reflected any caller's
  // origin back and let any website read our responses) keeps the browser from
  // handing this server's replies to another page.
  process.env.FRONTEND_ORIGIN = 'null'
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
  // Held so Settings can change the key on the running server without a restart.
  openaiService = await import(pathToFileURL(path.join(__dirname, 'backend', 'services', 'openai.js')).href)
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
    webPreferences: {
      preload: path.join(__dirname, 'main-preload.cjs'),
    },
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

// Synchronous so the preload can publish the token before any app code runs and
// no request can be made without it. Only our own windows load a preload, so
// this is not reachable from outside the app.
ipcMain.on('get-auth-token', (event) => {
  event.returnValue = AUTH_TOKEN
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

/** Show enough of the key to recognise it, never the whole thing. */
function maskKey(key) {
  if (!key) return ''
  return key.length <= 14 ? '••••' : `${key.slice(0, 10)}…${key.slice(-4)}`
}

ipcMain.handle('get-key-info', async () => ({ masked: maskKey(readApiKey()) }))

/**
 * Replace the stored key and apply it to the running backend immediately (the
 * SDK reads its key per request), so a change takes effect without a restart.
 */
ipcMain.handle('update-key', async (_event, key) => {
  const trimmed = String(key || '').trim()
  if (!trimmed) return { ok: false, message: 'Please paste your API key.' }
  writeApiKey(trimmed)
  openaiService?.setApiKey?.(trimmed)
  return { ok: true, masked: maskKey(trimmed) }
})

// First-run setup: the renderer posts the pasted key here.
ipcMain.handle('save-key', async (_event, key) => {
  const trimmed = String(key || '').trim()
  if (!trimmed) return { ok: false, message: 'Please paste your API key.' }
  writeApiKey(trimmed)
  setupWindow?.close()
  await boot(trimmed)
  return { ok: true }
})

// --- Menu -------------------------------------------------------------------
// Where the source and its issue tracker live. Also in build/app-update.yml,
// which electron-builder writes from the same two values in package.json.
const GH_REPO = 'pmk3796/language-practice-desktop'

/**
 * A GitHub issue with the details every bug report needs, already filled in.
 * People reporting a problem should not have to work out which build they are
 * on — and a report that omits it usually cannot be acted on.
 */
function reportProblemUrl() {
  const url = new URL(`https://github.com/${GH_REPO}/issues/new`)
  url.searchParams.set('title', '')
  url.searchParams.set(
    'body',
    [
      'What happened?',
      '',
      '',
      'What did you expect to happen?',
      '',
      '',
      '---',
      `App: ${app.getVersion()} (${process.arch})`,
      `macOS: ${process.getSystemVersion()}`,
      `Electron: ${process.versions.electron}`,
      '',
      "_Nothing above is sent automatically — you're filling this in yourself, and",
      'you can edit or delete any of it before posting._',
    ].join('\n'),
  )
  return url.toString()
}

/**
 * Replaces Electron's stock menu. That one carries a Help entry pointing at
 * electronjs.org, which is not this app's support channel. The roles below are
 * the standard macOS menus — editMenu in particular is not optional, since it
 * is what makes ⌘V work in the API-key field.
 */
function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
      {
        role: 'help',
        submenu: [
          {
            label: 'Report a Problem\u2026',
            click: () => shell.openExternal(reportProblemUrl()),
          },
          {
            label: 'View Source on GitHub',
            click: () => shell.openExternal(`https://github.com/${GH_REPO}`),
          },
        ],
      },
    ]),
  )
}

// --- App lifecycle ----------------------------------------------------------
// Let the practice audio play without a prior user gesture (replays etc).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

/**
 * Every window this app opens loads a file:// page we shipped, and the only
 * outbound links are the setup screen's, which go to the real browser through
 * the open-external handler. So nothing should ever navigate a window somewhere
 * else or spawn one — and if a bug or injected content tries, the renderer is
 * where the API key's IPC bridge lives. Deny both, for every window.
 */
function lockDownNavigation(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    // A target=_blank to a real site still belongs in the browser, not a
    // chrome-less Electron window with our preload attached.
    if (/^https:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (url !== contents.getURL()) event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
}

app.whenReady().then(async () => {
  buildMenu()

  app.on('web-contents-created', (_event, contents) => lockDownNavigation(contents))

  // Allow the microphone and nothing else. Electron's 'media' permission covers
  // camera as well as microphone, so granting it wholesale would let anything in
  // the renderer open the camera — checking mediaTypes is what keeps this to the
  // one device the app actually uses. macOS still shows its own system prompt
  // the first time.
  // The two handlers below describe the same request differently: the request
  // handler passes mediaTypes (an array), the check handler passes mediaType (a
  // single string). Reading only one of them silently denies the microphone, so
  // both shapes are handled, and anything that reports neither is refused.
  const audioOnly = (permission, details) => {
    if (permission !== 'media') return false
    if (Array.isArray(details?.mediaTypes)) {
      return details.mediaTypes.length > 0 && details.mediaTypes.every((type) => type === 'audio')
    }
    if (typeof details?.mediaType === 'string') return details.mediaType === 'audio'
    return false
  }

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(audioOnly(permission, details))
  })
  // The synchronous counterpart, consulted by navigator.permissions.query and by
  // some getUserMedia paths. Left at its default it answers independently of the
  // handler above, so it gets the same rule.
  session.defaultSession.setPermissionCheckHandler((_wc, permission, _origin, details) =>
    audioOnly(permission, details),
  )

  // Upgrade in place: a key stored in the clear by an earlier version gets
  // re-written encrypted, and the plaintext copy dropped, on the first launch
  // after that version.
  const stored = readConfig()
  if (stored.apiKey && safeStorage.isEncryptionAvailable()) writeApiKey(stored.apiKey)

  const apiKey = process.env.OPENAI_API_KEY || readApiKey()
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
