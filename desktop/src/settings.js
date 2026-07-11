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

// One-time migration: the app was renamed "Loki Doki" → "Doki Dock" (2026-07),
// which moved userData on both platforms. Carry over settings and the persisted
// login partition so existing installs keep their server URL and session. Runs
// at require-time so it lands before any window creates the 'persist:loki'
// partition; a failed copy just means a fresh first-run, never a crash.
function migrateFromOldName() {
  const dir = app.getPath('userData')
  if (fs.existsSync(settingsPath())) return
  const oldDir = path.join(path.dirname(dir), 'Loki Doki')
  if (!fs.existsSync(path.join(oldDir, 'settings.json'))) return
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(path.join(oldDir, 'settings.json'), settingsPath())
    const oldPartitions = path.join(oldDir, 'Partitions')
    if (fs.existsSync(oldPartitions)) {
      fs.cpSync(oldPartitions, path.join(dir, 'Partitions'), { recursive: true })
    }
  } catch {}
}
migrateFromOldName()

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
