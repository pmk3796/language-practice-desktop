const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('setupAPI', {
  saveKey: (key) => ipcRenderer.invoke('save-key', key),
})
