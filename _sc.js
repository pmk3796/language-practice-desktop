import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'; import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const wait = ms => new Promise(r => setTimeout(r, ms))
let win
ipcMain.handle('resize-setup', async (_e, h) => {
  const height = Math.max(360, Math.min(900, Math.round(Number(h) || 700)))
  const [w] = win.getContentSize(); win.setContentSize(w, height, true)
})
const AUDIT = fs.readFileSync('/tmp/audit-snippet.js', 'utf8')
app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 560, height: 700, show: true,
    webPreferences: { preload: path.join(__dirname, 'setup-preload.cjs') } })
  await win.loadFile(path.join(__dirname, 'setup.html'))
  win.webContents.setZoomFactor(1); win.webContents.setZoomLevel(0)
  const js = c => win.webContents.executeJavaScript(c)
  await wait(1100)

  const report = async (name) => {
    const bad = await js(AUDIT)
    console.log(bad.length ? `FAIL ${name}` : `ok   ${name}`)
    bad.forEach(l => console.log('      ' + l))
    fs.writeFileSync(`/tmp/sc-${name}.png`, (await win.webContents.capturePage()).toPNG())
    return bad.length
  }
  let n = await report('welcome')

  // Screen 2: the key form, its links and both status states.
  await js(`document.querySelector('#s-welcome .cta').click()`); await wait(900)
  n += await report('connect')
  await js(`(() => { const el = document.querySelector('.status')
    el.className = 'status err'; el.textContent = 'That key was rejected — check it was copied in full.'
    document.querySelector('input').classList.add('bad'); return true })()`)
  await wait(400); n += await report('error')
  await js(`(() => { const el = document.querySelector('.status')
    el.className = 'status busy'; el.innerHTML = '<span class="spinner"></span>Checking your key and credit…'
    document.querySelector('input').classList.remove('bad'); return true })()`)
  await wait(400); n += await report('busy')
  console.log(n ? `\n${n} contrast failures` : '\nno contrast failures on any setup screen')
  app.exit(0)
})
