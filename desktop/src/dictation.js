// System-wide dictation delivery: put transcribed text into whatever app currently
// has focus. The HUD renderer captures the mic and transcribes via the server's
// Whisper sidecar; this module is only the "type it into the focused app" tail.
//
// There is no Electron API to type into another app, and no native keystroke module
// is bundled (the shell has no build step). So we go through the clipboard and
// simulate a paste with an OS tool that is always present:
//   - macOS:  osascript → System Events "keystroke v using command down"
//   - Windows: PowerShell SendKeys ^v
//   - Linux:   xdotool ctrl+v (X11; best-effort)
// The user's prior clipboard is restored after a successful paste. If the paste
// cannot be simulated (e.g. macOS Accessibility not granted, or xdotool missing),
// the transcript is left on the clipboard and a notification tells the user to paste
// it manually - dictation never silently drops text.

const { clipboard, Notification } = require('electron')
const { execFile } = require('node:child_process')

function run(cmd, args) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 6000, windowsHide: true }, (err) => resolve(!err))
    } catch {
      resolve(false)
    }
  })
}

function simulatePaste() {
  if (process.platform === 'darwin') {
    return run('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down'])
  }
  if (process.platform === 'win32') {
    const ps = 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\'^v\')'
    return run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps])
  }
  return run('xdotool', ['key', '--clearmodifiers', 'ctrl+v'])
}

function notifyManual() {
  try {
    if (!Notification.isSupported()) return
    const key = process.platform === 'darwin' ? '⌘V' : 'Ctrl+V'
    const hint = process.platform === 'darwin'
      ? ' Grant MaiPai Desktop Accessibility access to paste automatically.'
      : ''
    new Notification({
      title: 'Dictation ready',
      body: `Copied to the clipboard - press ${key} to paste.${hint}`,
    }).show()
  } catch {
    /* notifications are best-effort */
  }
}

/** Deliver `text` into the focused app. Returns { ok } - ok=false means the text is
 *  on the clipboard for a manual paste. */
async function insertText(text) {
  const t = String(text ?? '')
  if (!t.trim()) return { ok: false, error: 'empty' }

  const prev = clipboard.readText()
  clipboard.writeText(t)
  // Let the clipboard write settle before the synthetic paste reads it.
  await new Promise((r) => setTimeout(r, 60))
  const pasted = await simulatePaste()

  if (pasted) {
    // Restore the user's clipboard once the paste has consumed ours.
    setTimeout(() => { try { clipboard.writeText(prev) } catch { /* ignore */ } }, 700)
    return { ok: true }
  }
  // Leave the transcript on the clipboard so it is never lost, and prompt the user.
  notifyManual()
  return { ok: false, error: 'paste_failed' }
}

module.exports = { insertText }
