const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('setupAPI', {
  // Checks the key against OpenAI (free call) before we commit to it.
  validateKey: (key) => ipcRenderer.invoke('validate-key', key),
  // Saves the key, closes setup, and boots the app.
  saveKey: (key) => ipcRenderer.invoke('save-key', key),
  // Opens a URL in the user's real browser rather than inside the app.
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  // Lets each screen size the window to its own content.
  resize: (height) => ipcRenderer.invoke('resize-setup', height),
})
