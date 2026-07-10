// Settings persistence: a plain JSON file in userData. Deliberately not
// electron-store (v10+ is ESM-only; this is 4 keys). Atomic write via tmp+rename
// so a crash mid-write never truncates the file.

const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

const DEFAULTS = {
  serverUrl: '',
  hotkey: 'CommandOrControl+Shift+Space',
  launchAtLogin: false,
  // Always-on companion posture: the HUD pill docks near the notch at boot with
  // the wake word armed, so you can just start talking. Turn off to make the
  // HUD summon-on-hotkey only.
  alwaysListening: true,
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function load() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8')
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULTS }
  }
}

function save(patch) {
  const next = { ...load(), ...patch }
  const file = settingsPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
  fs.renameSync(tmp, file)
  return next
}

module.exports = { load, save, settingsPath }
