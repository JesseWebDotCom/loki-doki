// Registry of live Pod connections, so server-side producers (the scheduler,
// notifications, ambient triggers) can push events to a user's connected Pods
// over their persistent Wyoming socket — the push channel the architecture relies
// on instead of device polling.

export interface PodFireEvent {
  kind: 'alarm' | 'timer'
  label: string
  tone?: string | null
  announce?: boolean
}

/** Anything that can receive a pushed event for a bound user (a SatelliteSession). */
export interface PodFireTarget {
  /** The user this connection is bound to (null until authenticated/resolved). */
  readonly boundUserId: string | null
  /** The paired device id this connection authenticated as (null until auth). */
  readonly deviceId: string | null
  /** Current conversation state for the admin live badge (idle|listening|thinking|talking). */
  readonly activity: string
  fire(event: PodFireEvent): void
  /** Speak a phrase on the device on demand (admin "Test" button). */
  testSpeak(text: string): Promise<void>
  /** Push effective settings (dimming, …) to the device over the live socket. */
  applyConfig(config: Record<string, unknown>): void
  /** Switch the device's screen mode (normal | camera-test | touch-test). */
  setDisplayMode(mode: string): void
  /** Push the slot-based dashboard descriptor (layout + theme + sound map). */
  applyLayout(descriptor: Record<string, unknown>): void
  /** Play a UI earcon for an event in the device's active sound pack. */
  playSound(event: string): void
  /** Ring a centralised alarm on this device (label + resolved tone url + snooze). */
  fireAlarm(a: { alarm_id: string; label: string; tone_url: string | null; snooze_minutes: number }): void
  /** Coordinated dismiss: stop a ringing alarm (sent to the OTHER targets). */
  stopAlarm(alarmId: string): void
  /** Tell the device to fetch custom WAVs (url + sha256) to its SD card once. */
  syncAssets(packId: string | null, files: Array<{ path: string; url: string; sha256: string }>): void
  /** Tear down this session (used to evict a stale duplicate when the device reconnects). */
  close(): void
}

const live = new Set<PodFireTarget>()

export function registerPod(target: PodFireTarget): void {
  live.add(target)
}

export function unregisterPod(target: PodFireTarget): void {
  live.delete(target)
}

/** Live Pods bound to a given user. */
export function podsForUser(userId: string): PodFireTarget[] {
  const out: PodFireTarget[] = []
  for (const t of live) if (t.boundUserId === userId) out.push(t)
  return out
}

/** Are any Pods connected at all? Lets producers skip work when nothing's listening. */
export function anyPodsConnected(): boolean {
  return live.size > 0
}

/** Device ids with a live gateway socket right now — the source of truth for the
 *  admin panel's online/offline dot (a paired device is "online" only while its
 *  Wyoming socket is open, distinct from the `lastSeenAt` timestamp). */
export function connectedDeviceIds(): Set<string> {
  const out = new Set<string>()
  for (const t of live) if (t.deviceId) out.add(t.deviceId)
  return out
}

/** deviceId → current conversation state, for the admin live-activity badge. */
export function connectedActivity(): Map<string, string> {
  const out = new Map<string, string>()
  for (const t of live) if (t.deviceId) out.set(t.deviceId, t.activity)
  return out
}

/** Make a connected device speak a phrase now (admin "Test" button). Returns false
 *  if the device isn't currently connected. Targets the MOST RECENT session. */
export function speakToDevice(deviceId: string, text: string): boolean {
  let target: PodFireTarget | null = null
  for (const t of live) if (t.deviceId === deviceId) target = t  // last wins (newest)
  if (!target) return false
  void target.testSpeak(text)
  return true
}

/** Push settings to a device's live session. Returns true if it was online and
 *  actually received it; false if offline (it'll pull on reconnect instead). */
export function configToDevice(deviceId: string, config: Record<string, unknown>): boolean {
  let reached = false
  for (const t of live) {
    if (t.deviceId === deviceId) {
      try { t.applyConfig(config); reached = true } catch { /* dead socket; ignore */ }
    }
  }
  return reached
}

/** Push a screen mode to a device's live session(s). Returns true if it was online
 *  and received it; false if offline (it'll pull its mode on reconnect instead). */
export function setModeToDevice(deviceId: string, mode: string): boolean {
  let reached = false
  for (const t of live) {
    if (t.deviceId === deviceId) {
      try { t.setDisplayMode(mode); reached = true } catch { /* dead socket; ignore */ }
    }
  }
  return reached
}

/** Push a freshly-resolved layout descriptor to a device's live session(s). Returns
 *  true if it reached an online socket (else the device pulls it on reconnect). */
export function layoutToDevice(deviceId: string, descriptor: Record<string, unknown>): boolean {
  let reached = false
  for (const t of live) {
    if (t.deviceId === deviceId) {
      try { t.applyLayout(descriptor); reached = true } catch { /* dead socket */ }
    }
  }
  return reached
}

/** Trigger a UI earcon on a device's live session(s). */
export function soundToDevice(deviceId: string, event: string): boolean {
  let reached = false
  for (const t of live) {
    if (t.deviceId === deviceId) {
      try { t.playSound(event); reached = true } catch { /* dead socket */ }
    }
  }
  return reached
}

/** Coordinated dismiss: tell every live session for a device to stop a ringing alarm. */
export function stopAlarmOnDevice(deviceId: string, alarmId: string): void {
  for (const t of live) if (t.deviceId === deviceId) { try { t.stopAlarm(alarmId) } catch { /* dead socket */ } }
}

/** Push a custom-asset sync manifest to a device's live session(s). */
export function assetSyncToDevice(deviceId: string, packId: string | null, files: Array<{ path: string; url: string; sha256: string }>): boolean {
  let reached = false
  for (const t of live) {
    if (t.deviceId === deviceId) {
      try { t.syncAssets(packId, files); reached = true } catch { /* dead socket */ }
    }
  }
  return reached
}

/** Live Pods bound to specific device ids (for targeted centralised alarms). */
export function podsForDevices(deviceIds: Set<string>): PodFireTarget[] {
  const out: PodFireTarget[] = []
  for (const t of live) if (t.deviceId && deviceIds.has(t.deviceId)) out.push(t)
  return out
}

/** A device only has one real connection — when it (re)authenticates, drop any
 *  earlier live sessions for the same device so pushes/TTS never hit a dead socket. */
export function evictForDevice(deviceId: string, keep: PodFireTarget): void {
  for (const t of [...live]) {
    if (t !== keep && t.deviceId === deviceId) {
      live.delete(t)
      try { t.close() } catch { /* already gone */ }
    }
  }
}
