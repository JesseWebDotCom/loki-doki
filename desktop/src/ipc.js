// ipcMain handlers for the server-loaded pages (preload.js bridge). Every
// handler rejects senders that are not the configured server origin: the
// windows are origin-locked anyway, but IPC is the privileged surface, so it
// double-checks rather than trusting navigation guards.

const { ipcMain, desktopCapturer, screen, shell } = require('electron')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { getMacScreenAccessStatus } = require('./permissions')

const execFileAsync = promisify(execFile)

// Battery snapshot, 60s cache. darwin only for now (pmset); Windows could use
// powershell WMI later. null = no battery / unsupported / error.
const batteryCache = { ts: 0, value: null }
async function readBattery() {
  if (Date.now() - batteryCache.ts < 60_000) return batteryCache.value
  batteryCache.ts = Date.now()
  if (process.platform !== 'darwin') {
    batteryCache.value = null
    return null
  }
  try {
    const { stdout } = await execFileAsync('pmset', ['-g', 'batt'])
    const pct = /(\d+)%/.exec(stdout)
    if (!pct) {
      batteryCache.value = null
      return null
    }
    const charging = /'AC Power'/.test(stdout) || /;\s*charging/.test(stdout)
    batteryCache.value = { percent: Number(pct[1]), charging }
  } catch {
    batteryCache.value = null
  }
  return batteryCache.value
}

// Last engine state reported by the /hud page; drives the tray label and the
// hide rules ("never hide a live mic").
const hudState = { listening: false, busy: false, sleeping: false, handsFreeOn: false }

function init({ getHud, getMain, getServerUrl, getSettings, onHudStateChanged, applyShellSettings, openSetup, quitApp }) {
  const fromServer = (event) => {
    try {
      return new URL(event.senderFrame.url).origin === new URL(getServerUrl()).origin
    } catch {
      return false
    }
  }

  ipcMain.on('hud:state', (event, state) => {
    if (!fromServer(event) || !state || typeof state !== 'object') return
    hudState.listening = !!state.listening
    hudState.busy = !!state.busy
    hudState.sleeping = !!state.sleeping
    hudState.handsFreeOn = !!state.handsFreeOn
    onHudStateChanged({ ...hudState })
  })

  // The window is click-through by default; the renderer opts painted regions
  // back in while the pointer is over them (and force-holds while the menu or a
  // typing session is open). See frontend useHudMouseIntercept.
  ipcMain.on('hud:set-mouse-intercept', (event, on) => {
    if (!fromServer(event)) return
    const hud = getHud()
    if (!hud || hud.isDestroyed()) return
    hud.setIgnoreMouseEvents(!on, { forward: true })
  })

  // Menu-bar/notch strip height of the HUD's display, so the renderer can sit
  // the capsule flush against the physical notch.
  ipcMain.handle('hud:get-insets', (event) => {
    if (!fromServer(event)) return { topInset: 0 }
    const hud = getHud()
    if (!hud || hud.isDestroyed()) return { topInset: 0 }
    const d = screen.getDisplayMatching(hud.getBounds())
    return { topInset: d.workArea.y - d.bounds.y }
  })

  // Screen awareness: a downscaled JPEG still of the display the cursor is on.
  // The renderer attaches it to a companion turn (existing images[] vision path).
  ipcMain.handle('screen:capture', async (event, opts) => {
    if (!fromServer(event)) return { ok: false, reason: 'error' }
    try {
      const maxDim = Math.min(2048, Math.max(640, Number(opts?.maxDim) || 1344))
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      const scale = Math.min(1, maxDim / Math.max(display.size.width, display.size.height))
      const thumbnailSize = {
        width: Math.round(display.size.width * scale),
        height: Math.round(display.size.height * scale),
      }
      const permitted = getMacScreenAccessStatus() === 'granted'
      // Even without permission, one getSources call is what registers the app
      // in System Settings > Privacy & Security > Screen Recording. On macOS it
      // REJECTS ("Failed to get sources") when the permission is missing.
      let sources
      try {
        sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize })
      } catch {
        return { ok: false, reason: permitted ? 'error' : 'permission' }
      }
      if (!permitted) return { ok: false, reason: 'permission' }
      const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
      if (!source) return { ok: false, reason: 'no-source' }
      if (source.thumbnail.isEmpty()) {
        return { ok: false, reason: process.platform === 'darwin' ? 'permission' : 'error' }
      }
      const size = source.thumbnail.getSize()
      return {
        ok: true,
        imageBase64: source.thumbnail.toJPEG(80).toString('base64'),
        width: size.width,
        height: size.height,
      }
    } catch (err) {
      console.error('[screen:capture]', err)
      return { ok: false, reason: 'error' }
    }
  })

  ipcMain.on('screen:open-permission-settings', (event) => {
    if (!fromServer(event)) return
    if (process.platform !== 'darwin') return
    void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
  })

  ipcMain.handle('system:battery', async (event) => {
    if (!fromServer(event)) return null
    return readBattery()
  })

  // Shell settings for the island's Settings page (tray keeps working too; both
  // read/write the same settings.js file). set-shell applies changes LIVE via
  // main.js (hotkey re-register with feedback, login item, listening posture).
  ipcMain.handle('settings:get-shell', (event) => {
    if (!fromServer(event)) return null
    const s = getSettings()
    let serverHost = ''
    try { serverHost = new URL(s.serverUrl).host } catch { /* unset */ }
    return {
      hotkey: s.hotkey,
      launchAtLogin: !!s.launchAtLogin,
      alwaysListening: s.alwaysListening !== false,
      serverHost,
    }
  })

  ipcMain.handle('settings:set-shell', (event, patch) => {
    if (!fromServer(event)) return { ok: false, error: 'denied' }
    return applyShellSettings(patch && typeof patch === 'object' ? patch : {})
  })

  ipcMain.on('settings:open-setup', (event) => {
    if (!fromServer(event)) return
    openSetup()
  })

  ipcMain.on('app:quit', (event) => {
    if (!fromServer(event)) return
    quitApp()
  })

  ipcMain.on('main:open', (event, path) => {
    if (!fromServer(event)) return
    const main = getMain()
    if (!main || main.isDestroyed()) return
    if (typeof path === 'string' && path.startsWith('/') && path !== '/') {
      void main.loadURL(new URL(path, getServerUrl()).toString())
    }
    main.show()
    main.focus()
  })

  ipcMain.handle('settings:get-server-url', (event) => {
    if (!fromServer(event)) return ''
    return getServerUrl()
  })

  ipcMain.handle('settings:get-startup-prefs', (event) => {
    if (!fromServer(event)) return { alwaysListening: false }
    return { alwaysListening: getSettings().alwaysListening !== false }
  })
}

function getHudState() {
  return { ...hudState }
}

module.exports = { init, getHudState }
