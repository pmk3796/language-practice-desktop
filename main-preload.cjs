const { contextBridge, ipcRenderer } = require('electron')

/**
 * Bridge for the main app window. Deliberately narrow: the renderer can check
 * and replace the API key, but can never read it back in full.
 */
contextBridge.exposeInMainWorld('desktopAPI', {
  // { masked: 'sk-proj-ab…WXYZ' } — enough to recognise which key is in use.
  getKeyInfo: () => ipcRenderer.invoke('get-key-info'),
  validateKey: (key) => ipcRenderer.invoke('validate-key', key),
  // Saves the key and hot-swaps it on the running backend.
  updateKey: (key) => ipcRenderer.invoke('update-key', key),
})
