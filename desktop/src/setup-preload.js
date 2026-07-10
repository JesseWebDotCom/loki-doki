// Bridge for the local first-run page (setup.html) only. Separate from the
// server-page preload so the setup surface can't reach the runtime IPC and
// server pages can't reach setup:save.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('lokiSetup', {
  currentUrl: () => ipcRenderer.invoke('setup:current-url'),
  validate: (url) => ipcRenderer.invoke('setup:validate', url),
  save: (url) => ipcRenderer.invoke('setup:save', url),
})
