// Bridge between the server-loaded pages and the shell. Runs sandboxed with
// contextIsolation; exposes the minimal surface typed on the frontend side in
// frontend/src/types/desktop.d.ts. Keep the two in sync.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('lokiDesktop', {
  platform: process.platform,

  // shell → page: hotkey/tray toggled listening
  onSetListening(cb) {
    const handler = (_event, on) => cb(!!on)
    ipcRenderer.on('companion:set-listening', handler)
    return () => ipcRenderer.removeListener('companion:set-listening', handler)
  },

  // shell → page: hotkey pressed while the HUD is docked; page expands (and
  // focuses the composer) or collapses back to the pill.
  onToggleExpand(cb) {
    const handler = () => cb()
    ipcRenderer.on('hud:toggle-expand', handler)
    return () => ipcRenderer.removeListener('hud:toggle-expand', handler)
  },

  // shell → page: open the drop shelf (from the tray "Drop a File…" item) so a file can be
  // dragged straight onto the dock.
  onOpenShelf(cb) {
    const handler = () => cb()
    ipcRenderer.on('hud:open-shelf', handler)
    return () => ipcRenderer.removeListener('hud:open-shelf', handler)
  },

  // page → shell
  reportState(state) {
    ipcRenderer.send('hud:state', state)
  },
  // Opt painted regions in/out of mouse interception (window is click-through
  // by default so the transparent area never blocks the apps behind it).
  setMouseIntercept(on) {
    ipcRenderer.send('hud:set-mouse-intercept', !!on)
  },
  getHudInsets() {
    return ipcRenderer.invoke('hud:get-insets')
  },
  // Screen awareness: downscaled JPEG still of the cursor's display.
  captureScreen(opts) {
    return ipcRenderer.invoke('screen:capture', opts ?? {})
  },
  openScreenRecordingSettings() {
    ipcRenderer.send('screen:open-permission-settings')
  },
  openMainWindow(path) {
    ipcRenderer.send('main:open', typeof path === 'string' ? path : '/')
  },
  getServerUrl() {
    return ipcRenderer.invoke('settings:get-server-url')
  },
  // Startup posture, so the page can arm the wake word on mount (survives
  // sign-in remounts and page reloads, which shell-side one-shot messages miss).
  getStartupPrefs() {
    return ipcRenderer.invoke('settings:get-startup-prefs')
  },
  // Island Settings page: read/write shell settings (applied live), battery
  // glance, server-setup window, quit.
  getShellSettings() {
    return ipcRenderer.invoke('settings:get-shell')
  },
  setShellSettings(patch) {
    return ipcRenderer.invoke('settings:set-shell', patch ?? {})
  },
  getBattery() {
    return ipcRenderer.invoke('system:battery')
  },
  // Local machine stats + threshold-alert events for the island System tab and
  // the HUD's server reporter.
  getResources() {
    return ipcRenderer.invoke('system:resources')
  },
  ackResourceEvents(ids) {
    return ipcRenderer.invoke('system:resources-ack', Array.isArray(ids) ? ids : [])
  },
  // Read-only file access (companion file ops + island settings management).
  // All enforcement happens in the main process; see desktop/src/fileAccess.js.
  fsRequest(req) {
    return ipcRenderer.invoke('fs:request', req ?? {})
  },
  fsPickFolder() {
    return ipcRenderer.invoke('fs:pick-folder')
  },
  fsRemoveRoot(root) {
    return ipcRenderer.invoke('fs:remove-root', root)
  },
  fsRecentAccesses() {
    return ipcRenderer.invoke('fs:recent-accesses')
  },
  openServerSetup() {
    ipcRenderer.send('settings:open-setup')
  },
  quitApp() {
    ipcRenderer.send('app:quit')
  },
})
