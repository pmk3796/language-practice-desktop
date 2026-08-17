import { app, BrowserWindow } from 'electron'
import path from 'node:path'; import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const wait = ms => new Promise(r => setTimeout(r, ms))
const now = Date.now()
const session = (msgs) => ({ id:'s1', language:'it', profile:'cafe', createdAt: now-3600_000, endedAt:null,
  messages: msgs, translations:[], corrections:[], recap:null })
const chatty = [
  { id:'m1', role:'assistant', text:'Buongiorno! Cosa desidera?', words:[{target:'Buongiorno',english:'Good morning'}] },
  { id:'m2', role:'user', text:'Vorrei un caffè per favore.' },
]
const seed = (theme, palette, msgs) => JSON.stringify({ theme, palette, homeLanguage:'all', draftLanguage:'it',
  draftProfile:'cafe', activeSessionId:'s1', sessions:[session(msgs)], flashcards:{ it: [] }, settingsVersion:2 })
const AUDIT = fs.readFileSync('/tmp/audit-snippet.js','utf8')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width:1280, height:900, show:true })
  await win.loadFile(path.join(__dirname,'frontend','index.html'))
  win.webContents.setZoomFactor(1); win.webContents.setZoomLevel(0)
  const js = c => win.webContents.executeJavaScript(c)
  let fails = 0
  for (const palette of ['focused','calm','confident'])
    for (const theme of ['light','dark']) {
      await js(`localStorage.setItem('language-practice:v2', ${JSON.stringify(seed(theme,palette,chatty))}); true`)
      await win.reload(); await wait(1700)
      const bad = await js(AUDIT); fails += bad.length
      if (bad.length) { console.log(`FAIL ${palette}/${theme}`); bad.forEach(l=>console.log('      '+l)) }
      if (palette === 'focused') {
        console.log(`${theme}: hint =`, JSON.stringify(await js(`document.querySelector('.recorder .hint').textContent.trim()`)))
        console.log(`${theme}: note =`, JSON.stringify(await js(`document.querySelector('.english-ok').textContent.replace(/\\s+/g,' ').trim()`)))
        fs.writeFileSync(`/tmp/eo-${theme}.png`, (await win.webContents.capturePage()).toPNG())
      }
    }
  // Still visible mid-recording and on a fresh conversation?
  console.log('shown with no messages yet:', await js(`(() => {
     localStorage.setItem('language-practice:v2', ${JSON.stringify(seed('light','focused',[]))}); return true })()`))
  await win.reload(); await wait(1700)
  console.log('  present:', await js(`!!document.querySelector('.english-ok')`))
  console.log(fails ? `\n${fails} contrast failures` : '\nno contrast failures on the conversation screen')
  app.exit(0)
})
