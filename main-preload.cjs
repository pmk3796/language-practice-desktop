const { contextBridge, ipcRenderer } = require('electron')

/**
 * Bridge for the main app window. Deliberately narrow: the renderer can check
 * and replace the API key, but can never read it back in full.
 */
contextBridge.exposeInMainWorld('desktopAPI', {
  // Per-launch shared secret the backend requires on every /api call. Fetched
  // synchronously here so it is in place before any app code can issue a
  // request. It authenticates this renderer to our own loopback server; it is
  // not the OpenAI key and grants nothing outside this machine.
  authToken: ipcRenderer.sendSync('get-auth-token'),
  // { masked: 'sk-proj-ab…WXYZ' } — enough to recognise which key is in use.
  getKeyInfo: () => ipcRenderer.invoke('get-key-info'),
  validateKey: (key) => ipcRenderer.invoke('validate-key', key),
  // Saves the key and hot-swaps it on the running backend.
  updateKey: (key) => ipcRenderer.invoke('update-key', key),
})
