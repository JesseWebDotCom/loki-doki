// Tray / menu-bar icon. The colored app icon on both platforms (the logo is 85%
// opaque, so a mac template image would render as a black blob; a proper
// monochrome glyph can replace this later). The menu is rebuilt whenever HUD
// state or settings change so the Start/Stop Listening and checkbox labels stay
// accurate.

const path = require('node:path')
const { Tray, Menu, nativeImage } = require('electron')

let tray = null

function iconPath() {
  return path.join(__dirname, '..', 'build', 'tray.png')
}

function create(handlers) {
  const image = nativeImage.createFromPath(iconPath())
  tray = new Tray(image)
  tray.setToolTip('MaiPai Desktop')
  rebuild(handlers)
  return tray
}

function rebuild({ state, settings, serverReachable, actions }) {
  if (!tray) return
  const serverHost = (() => {
    try { return new URL(settings.serverUrl).host } catch { return 'not set' }
  })()

  const menu = Menu.buildFromTemplate([
    { label: 'Show MaiPai Home', click: actions.showMain },
    {
      label: 'Show HUD',
      type: 'checkbox',
      checked: state.hudVisible,
      click: actions.toggleHud,
    },
    {
      label: state.listening ? 'Stop Listening' : 'Start Listening',
      accelerator: settings.hotkey,
      click: actions.toggleListening,
    },
    {
      label: 'Always Listening',
      type: 'checkbox',
      checked: settings.alwaysListening !== false,
      toolTip: 'Dock the pill and arm the wake word whenever the app starts',
      click: actions.toggleAlwaysListening,
    },
    { type: 'separator' },
    {
      label: 'Drop a File…',
      toolTip: 'Open the drop shelf, then drag a file onto the dock to hand it to your companion',
      click: actions.openDropShelf,
    },
    { type: 'separator' },
    {
      label: serverReachable ? `Server: ${serverHost}` : `Server unreachable: ${serverHost}`,
      enabled: false,
    },
    { label: 'Change Server…', click: actions.changeServer },
    { type: 'separator' },
    {
      label: 'Launch at Login',
      type: 'checkbox',
      checked: settings.launchAtLogin,
      click: actions.toggleLaunchAtLogin,
    },
    { label: 'Open Settings File', click: actions.openSettingsFile },
    { type: 'separator' },
    { label: 'Quit MaiPai Desktop', click: actions.quit },
  ])
  tray.setContextMenu(menu)
}

module.exports = { create, rebuild }
