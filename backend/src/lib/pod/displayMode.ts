// Per-device SCREEN MODE for screen Pods (Tab5), driven from Admin → Devices →
// Testing. A device's mode selects which LVGL page it shows:
//   • normal      — the ambient clock dashboard (the shipping default)
//   • camera-test — full-screen camera (a PUBLIC test feed, so it works with no
//                   Frigate; see cameraTest.startPublicCameraSource)
//   • touch-test  — blue screen, a pink dot wherever you press (touch accuracy/latency)
//
// Mode is pushed over the device's existing Wyoming socket (registry.setModeToDevice)
// and also re-sent on (re)connect (satelliteSession), so a device that was offline
// picks up its mode the moment it comes back. It's intentionally in-memory: test
// modes shouldn't survive a server restart (a Pod always boots back to normal).

import { setModeToDevice } from '@/lib/pod/registry'

export type DisplayMode = 'normal' | 'camera-test' | 'touch-test' | 'stream-deck'
export const DISPLAY_MODES: DisplayMode[] = ['normal', 'camera-test', 'touch-test', 'stream-deck']

export function isDisplayMode(v: unknown): v is DisplayMode {
  return typeof v === 'string' && (DISPLAY_MODES as string[]).includes(v)
}

// deviceId → mode. 'normal' is the implicit default (absent from the map).
const modes = new Map<string, DisplayMode>()

export function getDeviceMode(deviceId: string): DisplayMode {
  return modes.get(deviceId) ?? 'normal'
}

/** Set a device's screen mode and push it live. Returns true if the device was
 *  online and received it now (otherwise it'll get it on reconnect). */
export function setDeviceMode(deviceId: string, mode: DisplayMode): boolean {
  if (mode === 'normal') modes.delete(deviceId)
  else modes.set(deviceId, mode)
  return setModeToDevice(deviceId, mode)
}

/** True if ANY device is currently in camera-test mode — the camera UDP streamer
 *  uses this to decide whether to run a source at all (no camera = no ffmpeg). */
export function anyDeviceInCameraMode(): boolean {
  for (const m of modes.values()) if (m === 'camera-test') return true
  return false
}
