// System output volume for the machine the dock runs on (island Home page
// cluster: mute / down / up). No cross-platform OS API exists, so per-platform
// commands: AppleScript on macOS, virtual media keys on Windows (user32
// keybd_event, exactly what a keyboard's volume keys send, so the OS volume
// overlay appears too), amixer on Linux (best effort).

const { execFile } = require('node:child_process')

const MAC_SCRIPTS = {
  up: 'set volume output volume (((output volume of (get volume settings)) + 6) as integer)',
  down: 'set volume output volume (((output volume of (get volume settings)) - 6) as integer)',
  mute: 'set volume output muted (not (output muted of (get volume settings)))',
}

const WIN_KEYS = { up: 0xaf, down: 0xae, mute: 0xad }

function run(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 5000, windowsHide: true }, () => resolve())
  })
}

async function volumeCommand(action) {
  if (!Object.prototype.hasOwnProperty.call(WIN_KEYS, action)) return
  if (process.platform === 'darwin') {
    await run('osascript', ['-e', MAC_SCRIPTS[action]])
  } else if (process.platform === 'win32') {
    const vk = WIN_KEYS[action]
    const cmd = `$k=Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte b, byte s, int f, int e);' -Name kb -Namespace w -PassThru; $k::keybd_event(${vk},0,0,0); $k::keybd_event(${vk},0,2,0)`
    await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd])
  } else {
    await run('amixer', ['-D', 'pulse', 'sset', 'Master', action === 'up' ? '5%+' : action === 'down' ? '5%-' : 'toggle'])
  }
}

module.exports = { volumeCommand }
