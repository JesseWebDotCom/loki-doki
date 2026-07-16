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
const { ipcMain } = require('electron')

let hud = null
let mainWin = null
let setupWin = null
let isQuitting = false
let serverReachable = false
let currentSettings = settings.load()

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
  setupWin.on('closed', () => { setupWin = null })
}

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
    return
  }
  // First configure: an always-on companion should come back after reboot.
  // Only for the packaged app - in dev this would register the bare Electron binary.
  if (app.isPackaged && !currentSettings.launchAtLogin) {
    currentSettings = settings.save({ launchAtLogin: true })
    app.setLoginItemSettings({ openAtLogin: true })
  }
  serverReachable = true
  setupWin?.close()
  // First boot: the user still needs to sign in, so open the main window too.
  bootWindows({ showMainWindow: true })
})

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

function tryRegisterHotkey(accelerator) {
  globalShortcut.unregisterAll()
  try {
    return globalShortcut.register(accelerator, onHotkey)
  } catch {
    return false
  }
}

function registerHotkey(accelerator) {
  if (!tryRegisterHotkey(accelerator)) {
    dialog.showErrorBox(
      'Hotkey unavailable',
      `${accelerator} could not be registered (maybe another app owns it). ` +
      'Change it in the island Settings page (gear) or the tray settings file.',
    )
  }
}

// Applies a partial settings patch LIVE (island Settings page via IPC). Hotkey
// changes only persist when registration succeeds; a failed attempt restores
// the previous hotkey and reports the error inline.
function applyShellSettings(patch) {
  const next = {}
  if (typeof patch.launchAtLogin === 'boolean') next.launchAtLogin = patch.launchAtLogin
  if (typeof patch.alwaysListening === 'boolean') next.alwaysListening = patch.alwaysListening
  if (typeof patch.hotkey === 'string' && patch.hotkey.trim()) next.hotkey = patch.hotkey.trim()
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

  if (next.hotkey && next.hotkey !== currentSettings.hotkey) {
    if (!tryRegisterHotkey(next.hotkey)) {
      tryRegisterHotkey(currentSettings.hotkey)
      return { ok: false, error: 'That hotkey could not be registered. Another app may own it.' }
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

  registerHotkey(currentSettings.hotkey)
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
