// Mic (getUserMedia) permission for the voice pipeline. Chromium asks the app;
// grant media to the configured server origin only, deny everything else.
// macOS additionally needs the OS-level mic consent (askForMediaAccess), which
// pops the system dialog once; NSMicrophoneUsageDescription comes from
// electron-builder's mac.extendInfo.

const { session, systemPreferences } = require('electron')

function install(partition, serverOrigin) {
  const ses = session.fromPartition(partition)

  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    let origin = ''
    try { origin = new URL(details.requestingUrl).origin } catch { /* deny */ }
    callback(permission === 'media' && origin === serverOrigin)
  })

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return permission === 'media' && requestingOrigin === serverOrigin
  })
}

async function ensureMacMicAccess() {
  if (process.platform !== 'darwin') return true
  const status = systemPreferences.getMediaAccessStatus('microphone')
  if (status === 'granted') return true
  return systemPreferences.askForMediaAccess('microphone')
}

// Screen Recording has no ask API on macOS: the app appears in System Settings'
// list only after a capture attempt, and grants need a full app relaunch.
function getMacScreenAccessStatus() {
  if (process.platform !== 'darwin') return 'granted'
  return systemPreferences.getMediaAccessStatus('screen')
}

module.exports = { install, ensureMacMicAccess, getMacScreenAccessStatus }
