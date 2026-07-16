// Window management: the always-on-top HUD pill near the notch and the normal
// main app window. Both load from the server origin on the shared persistent
// partition, so one profile-picker login covers both (7-day session cookie).

const path = require('node:path')
const { BrowserWindow, screen, shell } = require('electron')

const PARTITION = 'persist:loki'

// Window/taskbar icon for dev + Windows/Linux (packaged mac uses the .icns).
const APP_ICON = path.join(__dirname, '..', 'build', 'icon.png')

// The HUD window is ONE fixed size, always: the Dynamic-Island capsule morphs
// with CSS inside it (window-bounds resizes can't animate smoothly). The window
// is click-through by default (setIgnoreMouseEvents with forward), and the
// renderer opts painted regions back in via the hud:set-mouse-intercept IPC,
// so the big transparent area never swallows clicks.
const HUD_SIZE = { width: 700, height: 520 }
// A physical notch strip is ~37-44px tall on notched MacBooks; a plain menu bar on an
// external display is ~24-25px. Only insets at least this tall count as a real notch, so
// external/notchless displays never get a fake notch core (they show the slim pill).
const NOTCH_MIN_INSET = 32

const commonWebPreferences = (serverOrigin) => ({
  preload: path.join(__dirname, 'preload.js'),
  partition: PARTITION,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  // TTS plays through an AudioContext with no click gesture (hands-free replies).
  autoplayPolicy: 'no-user-gesture-required',
  additionalArguments: [`--loki-server-origin=${serverOrigin}`],
})

// Keep both windows on the server origin; anything else opens in the OS browser.
function lockToOrigin(win, serverOrigin) {
  const isOurs = (url) => {
    try { return new URL(url).origin === serverOrigin } catch { return false }
  }
  win.webContents.on('will-navigate', (e, url) => {
    if (!isOurs(url)) { e.preventDefault(); void shell.openExternal(url) }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isOurs(url)) return { action: 'allow' }
    void shell.openExternal(url)
    return { action: 'deny' }
  })
}

function createHudWindow(serverUrl) {
  const serverOrigin = new URL(serverUrl).origin
  const hud = new BrowserWindow({
    ...HUD_SIZE,
    // NSPanel on macOS: ordinary windows get clamped BELOW the menu bar, so a
    // y=0 request lands at the strip's bottom edge; panels may overlap it, which
    // is what lets the capsule sit flush against the notch.
    ...(process.platform === 'darwin' ? { type: 'panel', hiddenInMissionControl: true, enableLargerThanScreen: true } : {}),
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      ...commonWebPreferences(serverOrigin),
      // The wake-word/VAD loop must keep running while other apps are focused.
      backgroundThrottling: false,
    },
  })
  // 'screen-saver' level floats above fullscreen apps and the mac menu bar.
  hud.setAlwaysOnTop(true, 'screen-saver')
  hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  // Click-through by default; forward keeps mousemove flowing to the renderer so
  // pointerenter on the capsule can flip interception on before a click lands.
  hud.setIgnoreMouseEvents(true, { forward: true })
  lockToOrigin(hud, serverOrigin)
  void hud.loadURL(new URL('/hud', serverUrl).toString())
  return hud
}

// Top-center of the display the cursor is on, flush with the screen top so the
// capsule can merge with the notch ('screen-saver' level paints above the menu
// bar). The renderer decides its own top padding from hud:get-insets.
function positionHud(hud) {
  const { width, height } = HUD_SIZE
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const wa = display.workArea
  const notched = wa.y - display.bounds.y >= NOTCH_MIN_INSET
  hud.setBounds({
    x: Math.round(wa.x + (wa.width - width) / 2),
    // Notched: flush to the physical top so the capsule merges with the notch. Notchless
    // or external: float just below the menu bar so the pill reads as a clean floating
    // capsule and never hides menu-bar status items.
    y: notched ? display.bounds.y : Math.round(wa.y + 8),
    width,
    height,
  })
}

function createMainWindow(serverUrl, { onCloseHide, show = true }) {
  const serverOrigin = new URL(serverUrl).origin
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    icon: APP_ICON,
    // Background-presence posture: on a normal boot the shell is just the docked
    // HUD + tray; the full app window opens on demand (tray, avatar click, sign-in).
    show,
    webPreferences: commonWebPreferences(serverOrigin),
  })
  lockToOrigin(win, serverOrigin)
  // Closing the window keeps the shell (tray + HUD) alive; quit lives in the tray.
  win.on('close', (e) => {
    if (onCloseHide()) {
      e.preventDefault()
      win.hide()
    }
  })
  void win.loadURL(serverUrl)
  return win
}

module.exports = { createHudWindow, createMainWindow, positionHud, HUD_SIZE, NOTCH_MIN_INSET, PARTITION }
