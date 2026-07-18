// Doki Dock, the Loki Doki desktop shell: a thin Electron wrapper around the web
// app served by the home server. Two windows on one persistent partition (log in once):
//   - HUD: frameless transparent always-on-top pill near the notch, loads /hud
//   - Main: a normal window with the full app (chat, music, videos, ...)
// A global hotkey summons the HUD and toggles hands-free listening. All features
// live in the web app; this process only does windows, tray, hotkey, permissions.

const { app, globalShortcut, net, shell, BrowserWindow, dialog } = require('electron')
const path = require('node:path')
const settings = require('./settings')
const windows = require('./windows')
const tray = require('./tray')
const ipc = require('./ipc')
const permissions = require('./permissions')
const resources = require('./resources')
const dictation = require('./dictation')
const { ipcMain } = require('electron')

let hud = null
let mainWin = null
let setupWin = null
let isQuitting = false
let serverReachable = false
let currentSettings = settings.load()

// The shell usually points at a plain-http LAN origin (http://192.168.x.x:3000),
// which Chromium treats as insecure: navigator.mediaDevices does not exist
// there, so the wake word and mic can never start and the island's companion
// fails to boot. The server is the user's own home hub, so declare its origin
// trustworthy; the renderer then gets the full secure-context APIs. localhost
// dev setups count as secure already, which is how this stayed hidden.
// (Must be set before app 'ready'; a server change relaunches the app, so the
// switch always carries the current origin.)
if (currentSettings.serverUrl) {
  try {
    app.commandLine.appendSwitch(
      'unsafely-treat-insecure-origin-as-secure',
      new URL(currentSettings.serverUrl).origin,
    )
  } catch { /* malformed stored URL; setup flow will replace it */ }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.show()
      mainWin.focus()
    }
  })
}

// ── Server health ──────────────────────────────────────────────────────────────

async function checkServer(url) {
  try {
    const res = await net.fetch(new URL('/api/health', url).toString(), {
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return { ok: false, error: `Server responded ${res.status}.` }
    return { ok: true }
  } catch {
    return { ok: false, error: 'Could not reach the server.' }
  }
}

// Accepts "192.168.1.10:3000", "http://host:3000/", etc.
function normalizeServerUrl(raw) {
  let value = String(raw ?? '').trim()
  if (!value) return null
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

// ── First-run / change-server window ───────────────────────────────────────────

function openSetup() {
  if (setupWin && !setupWin.isDestroyed()) {
    setupWin.show()
    setupWin.focus()
    return
  }
  setupWin = new BrowserWindow({
    width: 480,
    height: 340,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'setup-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  setupWin.removeMenu?.()
  void setupWin.loadFile(path.join(__dirname, 'setup.html'))
  setupWin.on('closed', () => {
    setupWin = null
    // Single boot trigger for first run: whether the user clicked "Open Doki Dock"
    // (setup:finish closes the window) or dismissed the primer, bring the app up so
    // a configured hub is never left as a tray-only process. Already-running
    // (change-server) and not-yet-configured cases skip this.
    if (currentSettings.serverUrl && !hud && !mainWin && !isQuitting) {
      bootWindows({ showMainWindow: true })
    }
  })
}

// Running shell version, for the web app's "Get the desktop app" menu status.
ipcMain.handle('app:version', () => app.getVersion())

ipcMain.handle('setup:current-url', () => currentSettings.serverUrl)

ipcMain.handle('setup:validate', async (_event, raw) => {
  const url = normalizeServerUrl(raw)
  if (!url) return { ok: false, error: 'Enter an address like http://192.168.1.10:3000.' }
  const health = await checkServer(url)
  return health.ok ? { ok: true, url } : { ok: false, error: health.error }
})

ipcMain.handle('setup:save', async (_event, url) => {
  currentSettings = settings.save({ serverUrl: url })
  if (hud || mainWin) {
    // Server changed at runtime: origin locks, permission handlers, and loaded
    // pages all point at the old origin - a clean relaunch is simpler than rewiring.
    app.relaunch()
    isQuitting = true
    app.exit(0)
    return { needsPermissions: false }
  }
  // First configure: an always-on companion should come back after reboot.
  // Only for the packaged app - in dev this would register the bare Electron binary.
  if (app.isPackaged && !currentSettings.launchAtLogin) {
    currentSettings = settings.save({ launchAtLogin: true })
    app.setLoginItemSettings({ openAtLogin: true })
  }
  serverReachable = true
  // macOS: walk the user through mic (and the screen-awareness quirk) before the
  // app opens, so the companion can actually hear them on first use. The primer
  // lives in the same setup window (a second panel); setup:finish boots after it.
  // Nothing to prime on other platforms, so boot straight away there.
  if (process.platform === 'darwin') {
    // Keep the window open for the primer; setup:finish (or dismissal) closes it,
    // and the 'closed' handler boots the app.
    setupWin?.setContentSize(480, 560)
    setupWin?.center()
    return { needsPermissions: true }
  }
  // Other platforms have no primer: closing the window boots via 'closed'.
  setupWin?.close()
  return { needsPermissions: false }
})

// Primer actions (macOS first run). ensureMacMicAccess pops the OS mic consent
// once; the screen status is informational (macOS only lists the app under
// Screen Recording after its first capture, and needs a relaunch to take hold).
ipcMain.handle('setup:request-mic', () => permissions.ensureMacMicAccess())
ipcMain.handle('setup:screen-status', () => permissions.getMacScreenAccessStatus())
// Closing the window is the single boot trigger (see openSetup's 'closed' handler).
ipcMain.handle('setup:finish', () => { setupWin?.close() })

// ── HUD + listening control ────────────────────────────────────────────────────

function sendSetListening(on) {
  if (!hud || hud.isDestroyed()) return
  if (on) {
    // First listen on macOS pops the OS mic consent; don't block the show.
    void permissions.ensureMacMicAccess()
  }
  hud.webContents.send('companion:set-listening', on)
}

function summonHud(listen) {
  if (!hud || hud.isDestroyed()) return
  windows.positionHud(hud)
  hud.show()
  if (listen) sendSetListening(true)
  refreshTray()
}

function dismissHud() {
  if (!hud || hud.isDestroyed()) return
  // Never hide a live mic: switch listening off before the window goes away.
  if (ipc.getHudState().handsFreeOn) sendSetListening(false)
  hud.hide()
  refreshTray()
}

function toggleListening() {
  const state = ipc.getHudState()
  if (!hud || hud.isDestroyed()) return
  if (!hud.isVisible()) {
    summonHud(true)
  } else if (state.handsFreeOn) {
    sendSetListening(false)
  } else {
    windows.positionHud(hud)
    sendSetListening(true)
  }
}

function onHotkey() {
  if (!hud || hud.isDestroyed()) return
  if (!hud.isVisible()) {
    summonHud(true)
    return
  }
  // Docked and visible (the normal always-on state): the hotkey toggles between
  // the pill and the expanded composer view; the page owns the transition.
  hud.webContents.send('hud:toggle-expand')
}

// Dictation hotkey: the page toggles a mic capture and, on finalize, hands the
// transcript back via the 'dictation:insert' IPC (below). We deliberately do NOT
// show/focus the HUD here - stealing focus would send the paste to the wrong app.
function onDictationHotkey() {
  if (!hud || hud.isDestroyed()) return
  void permissions.ensureMacMicAccess() // first dictation on macOS pops mic consent
  hud.webContents.send('dictation:toggle')
}

function tryRegister(accelerator, handler) {
  try {
    return globalShortcut.register(accelerator, handler)
  } catch {
    return false
  }
}

// Both global shortcuts share one registry, so any re-register wipes and re-adds
// the pair. Returns which accelerators took.
function registerHotkeys() {
  globalShortcut.unregisterAll()
  const main = tryRegister(currentSettings.hotkey, onHotkey)
  const dict = currentSettings.dictationHotkey
    ? tryRegister(currentSettings.dictationHotkey, onDictationHotkey)
    : true
  return { main, dict }
}

function registerHotkey() {
  const { main, dict } = registerHotkeys()
  if (!main) {
    dialog.showErrorBox(
      'Hotkey unavailable',
      `${currentSettings.hotkey} could not be registered (maybe another app owns it). ` +
      'Change it in the island Settings page (gear) or the tray settings file.',
    )
  }
  if (currentSettings.dictationHotkey && !dict) {
    dialog.showErrorBox(
      'Dictation hotkey unavailable',
      `${currentSettings.dictationHotkey} could not be registered (maybe another app owns it, ` +
      'or it matches your HUD hotkey). Change it in the island Settings page or the tray settings file.',
    )
  }
}

// page → shell: a finalized dictation transcript to paste into the focused app.
ipcMain.handle('dictation:insert', (_event, text) => dictation.insertText(String(text ?? '')))

// Applies a partial settings patch LIVE (island Settings page via IPC). Hotkey
// changes only persist when registration succeeds; a failed attempt restores
// the previous hotkey and reports the error inline.
function applyShellSettings(patch) {
  const next = {}
  if (typeof patch.launchAtLogin === 'boolean') next.launchAtLogin = patch.launchAtLogin
  if (typeof patch.alwaysListening === 'boolean') next.alwaysListening = patch.alwaysListening
  if (typeof patch.hotkey === 'string' && patch.hotkey.trim()) next.hotkey = patch.hotkey.trim()
  if (typeof patch.dictationHotkey === 'string') next.dictationHotkey = patch.dictationHotkey.trim() // '' disables
  // Resource monitoring thresholds/toggles (numbers are clamped in resources.js).
  if (patch.resourceMonitor && typeof patch.resourceMonitor === 'object') {
    const rm = { ...currentSettings.resourceMonitor }
    for (const k of ['enabled', 'announce']) {
      if (typeof patch.resourceMonitor[k] === 'boolean') rm[k] = patch.resourceMonitor[k]
    }
    for (const k of ['cpuPct', 'cpuSustainMin', 'memPct', 'diskFreePct', 'batteryPct']) {
      if (Number.isFinite(Number(patch.resourceMonitor[k]))) rm[k] = Number(patch.resourceMonitor[k])
    }
    next.resourceMonitor = rm
  }
  // File access: the page may flip ONLY the boolean. Allowed roots are added
  // exclusively through the native folder picker (fs:pick-folder) — a
  // server-controlled page must never be able to grant itself new paths.
  if (typeof patch.fileAccessEnabled === 'boolean') next.fileAccessEnabled = patch.fileAccessEnabled

  const hotkeyChanged =
    (next.hotkey && next.hotkey !== currentSettings.hotkey) ||
    ('dictationHotkey' in next && next.dictationHotkey !== currentSettings.dictationHotkey)
  if (hotkeyChanged) {
    const prev = { hotkey: currentSettings.hotkey, dictationHotkey: currentSettings.dictationHotkey }
    // registerHotkeys() reads currentSettings, so stage the candidates before validating.
    currentSettings = {
      ...currentSettings,
      ...(next.hotkey ? { hotkey: next.hotkey } : {}),
      ...('dictationHotkey' in next ? { dictationHotkey: next.dictationHotkey } : {}),
    }
    const { main, dict } = registerHotkeys()
    if (!main || !dict) {
      currentSettings = { ...currentSettings, ...prev }
      registerHotkeys() // restore the working pair
      return {
        ok: false,
        error: !main
          ? 'That hotkey could not be registered. Another app may own it.'
          : 'That dictation hotkey could not be registered. It may clash with another app or your HUD hotkey.',
      }
    }
  }

  currentSettings = settings.save(next)
  if ('resourceMonitor' in next) resources.applyConfig()
  if ('launchAtLogin' in next) app.setLoginItemSettings({ openAtLogin: next.launchAtLogin })
  if ('alwaysListening' in next) {
    sendSetListening(next.alwaysListening)
    if (next.alwaysListening && hud && !hud.isDestroyed() && !hud.isVisible()) {
      windows.positionHud(hud)
      hud.showInactive()
    }
  }
  refreshTray()
  return { ok: true }
}

// ── Tray ───────────────────────────────────────────────────────────────────────

function refreshTray() {
  tray.rebuild({
    state: {
      hudVisible: !!hud && !hud.isDestroyed() && hud.isVisible(),
      listening: ipc.getHudState().handsFreeOn,
    },
    settings: currentSettings,
    serverReachable,
    actions: trayActions,
  })
}

const trayActions = {
  showMain() {
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.show()
      mainWin.focus()
    }
  },
  toggleHud() {
    if (!hud || hud.isDestroyed()) return
    if (hud.isVisible()) dismissHud()
    else summonHud(false)
  },
  openDropShelf() {
    if (!hud || hud.isDestroyed()) return
    // Reliable drop path (#2): show the dock and open its drop shelf so a file can be
    // dragged straight onto it. (A click-through window can't detect an OS drag hovering
    // it, so we open the shelf on request rather than on drag-over.)
    if (!hud.isVisible()) summonHud(false)
    hud.webContents.send('hud:open-shelf')
    refreshTray()
  },
  toggleListening() {
    toggleListening()
    refreshTray()
  },
  changeServer: openSetup,
  toggleAlwaysListening() {
    const next = currentSettings.alwaysListening === false
    currentSettings = settings.save({ alwaysListening: next })
    // Apply now, not just at next boot.
    sendSetListening(next)
    if (next && hud && !hud.isDestroyed() && !hud.isVisible()) {
      windows.positionHud(hud)
      hud.showInactive()
    }
    refreshTray()
  },
  toggleLaunchAtLogin() {
    const next = !currentSettings.launchAtLogin
    currentSettings = settings.save({ launchAtLogin: next })
    app.setLoginItemSettings({ openAtLogin: next })
    refreshTray()
  },
  openSettingsFile() {
    void shell.openPath(settings.settingsPath())
  },
  quit() {
    isQuitting = true
    app.quit()
  },
}

// ── Boot ───────────────────────────────────────────────────────────────────────

function bootWindows({ showMainWindow = false } = {}) {
  const serverUrl = currentSettings.serverUrl
  const serverOrigin = new URL(serverUrl).origin
  permissions.install(windows.PARTITION, serverOrigin)

  hud = windows.createHudWindow(serverUrl)
  mainWin = windows.createMainWindow(serverUrl, {
    onCloseHide: () => !isQuitting,
    show: showMainWindow,
  })

  // Always-on posture: dock the pill near the notch as soon as the page is up,
  // without stealing focus from whatever the user is doing. The page arms the
  // wake word itself (getStartupPrefs) once signed in.
  hud.webContents.on('did-finish-load', () => {
    if (hud.isVisible()) return
    windows.positionHud(hud)
    hud.showInactive()
    refreshTray()
  })
  if (currentSettings.alwaysListening !== false) {
    void permissions.ensureMacMicAccess()
  }

  ipc.init({
    getHud: () => hud,
    getMain: () => mainWin,
    getServerUrl: () => currentSettings.serverUrl,
    getSettings: () => currentSettings,
    onHudStateChanged: () => refreshTray(),
    applyShellSettings,
    saveFileAccessRoots: (roots) => {
      currentSettings = settings.save({ fileAccessRoots: roots })
    },
    openSetup,
    quitApp: () => trayActions.quit(),
  })

  registerHotkey()
  refreshTray()

  resources.start(
    () => currentSettings,
    (machineId) => { currentSettings = settings.save({ machineId }) },
  )
}

app.whenReady().then(async () => {
  // Packaged builds get the icon from electron-builder's generated .icns/.ico;
  // dev (`electron .`) would otherwise show the default Electron logo in the Dock.
  if (!app.isPackaged && process.platform === 'darwin') {
    app.dock?.setIcon(path.join(__dirname, '..', 'build', 'icon.png'))
  }
  tray.create({
    state: { hudVisible: false, listening: false },
    settings: currentSettings,
    serverReachable,
    actions: trayActions,
  })

  if (!currentSettings.serverUrl) {
    openSetup()
    return
  }

  const health = await checkServer(currentSettings.serverUrl)
  serverReachable = health.ok
  if (!health.ok) {
    // Boot anyway (the server may come up later); surface it and offer setup.
    refreshTray()
    openSetup()
  }
  bootWindows()
})

app.on('activate', () => {
  // Dock icon click on macOS.
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.show()
    mainWin.focus()
  }
})

app.on('window-all-closed', () => {
  // Tray app: stay alive; Quit lives in the tray menu.
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})
