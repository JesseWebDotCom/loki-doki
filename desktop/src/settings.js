// Settings persistence: a plain JSON file in userData. Deliberately not
// electron-store (v10+ is ESM-only; this is 4 keys). Atomic write via tmp+rename
// so a crash mid-write never truncates the file.

const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

const DEFAULTS = {
  // The address we are currently using. Still a single string because at any moment
  // there is exactly one, but it is now chosen from `endpoints` rather than typed once
  // and frozen forever.
  serverUrl: '',
  // Cached copy of the hub's address book, refreshed whenever we are connected. This is
  // what a cold start walks through, so it has to survive on disk: the launch where DNS
  // is down is exactly the launch where we cannot go ask the server for it.
  // [{ name, url, kind: 'lan' | 'overlay' | 'public', priority }]
  endpoints: [],
  // Identity of the hub these addresses belong to. Every probe must match it before we
  // will talk to the address, so a stranger's server on the same LAN IP is rejected
  // instead of being handed a login.
  hubInstanceId: '',
  hubName: '',
  // Which address answered last time, tried first on the next launch.
  lastGoodUrl: '',
  hotkey: 'CommandOrControl+Shift+Space',
  // System-wide dictation: press to start capturing the mic, press again (or pause)
  // to finalize; the transcript is pasted into whatever app has focus. Empty string
  // disables it. Kept separate from `hotkey` so dictation never steals the HUD toggle.
  dictationHotkey: 'CommandOrControl+Shift+D',
  launchAtLogin: false,
  // Always-on companion posture: the HUD pill docks near the notch at boot with
  // the wake word armed, so you can just start talking. Turn off to make the
  // HUD summon-on-hotkey only.
  alwaysListening: true,
  // Stable per-install id stamped on resource snapshots/alerts so a household
  // with several docks dedupes per machine. Generated on first collector start.
  machineId: '',
  // Local resource monitoring (CPU/memory/disk/battery) with threshold alerts.
  // announce = the companion also speaks alerts aloud (via the server).
  resourceMonitor: {
    enabled: true,
    announce: false,
    cpuPct: 90,
    cpuSustainMin: 5,
    memPct: 90,
    diskFreePct: 10,
    batteryPct: 15,
  },
  // Read-only file access for the companion (list/read inside user-picked folders
  // only). Off by default; roots are added exclusively via the native folder
  // picker — never by the server-loaded page.
  fileAccessEnabled: false,
  fileAccessRoots: [],
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
  let stored
  try {
    stored = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
  // Installs that predate the address book have one hand-typed URL. Seed it as the
  // first entry so nothing changes for them until the hub sends its own list.
  if (stored.serverUrl && !stored.endpoints?.length) {
    stored.endpoints = [{ name: 'Saved address', url: stored.serverUrl, kind: 'lan', priority: 10 }]
  }
  return stored
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
