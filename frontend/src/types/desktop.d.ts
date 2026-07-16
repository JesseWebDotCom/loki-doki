// Bridge exposed by the desktop shell's preload script (desktop/src/preload.js).
// Present only when the app is running inside the Loki Doki desktop app; every
// consumer must feature-detect (`window.lokiDesktop?.…`). Optional members mark
// newer bridge additions so the frontend tolerates an older installed shell.

export interface HudState {
  listening: boolean
  busy: boolean
  sleeping: boolean
  handsFreeOn: boolean
}

export interface StartupPrefs {
  /** Dock the capsule and arm the wake word at startup (tray > Always Listening). */
  alwaysListening: boolean
}

export type ScreenCaptureResult =
  | { ok: true; imageBase64: string; width: number; height: number }
  | { ok: false; reason: 'permission' | 'no-source' | 'error' }

export interface ResourceMonitorSettings {
  enabled: boolean
  /** The companion also speaks alerts aloud (routed through the server). */
  announce: boolean
  cpuPct: number
  cpuSustainMin: number
  memPct: number
  diskFreePct: number
  batteryPct: number
}

export interface ShellSettings {
  hotkey: string
  launchAtLogin: boolean
  alwaysListening: boolean
  serverHost: string
  /** Newer shells only. */
  resourceMonitor?: ResourceMonitorSettings
  fileAccessEnabled?: boolean
  fileAccessRoots?: string[]
}

export interface BatteryStatus {
  percent: number
  charging: boolean
}

export interface ResourceSnapshot {
  at: number
  cpuPct: number | null
  cpuCount: number
  loadAvg1m: number
  memUsedPct: number | null
  memTotalGb: number
  memFreeGb: number
  diskFreePct: number | null
  diskFreeGb: number | null
  diskTotalGb: number | null
  battery: BatteryStatus | null
}

export interface ResourceEvent {
  id: string
  metric: 'cpu' | 'memory' | 'disk' | 'battery'
  state: 'firing' | 'recovered'
  value: number
  threshold: number
  message: string
  at: number
}

export interface ResourceState {
  machineId: string
  hostname: string
  platform: string
  enabled: boolean
  announce: boolean
  snapshot: ResourceSnapshot | null
  firing: string[]
  recentAlerts: ResourceEvent[]
  pendingEvents: ResourceEvent[]
}

export type FsRequestResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string }

export interface FsAccessEntry {
  action: string
  path: string
  ok: boolean
  at: number
}

export interface LokiDesktopBridge {
  platform: string
  /** Subscribe to listen-toggle commands from the shell (hotkey/tray). Returns unsubscribe. */
  onSetListening: (cb: (on: boolean) => void) => () => void
  /** Hotkey pressed while the HUD is visible: flip between base capsule and composer. Returns unsubscribe. */
  onToggleExpand: (cb: () => void) => () => void
  onOpenShelf: (cb: () => void) => () => void
  /** Report companion engine state so the tray label and hide rules stay accurate. */
  reportState: (state: HudState) => void
  /** Opt painted regions in/out of mouse interception; the window is click-through by default. */
  setMouseIntercept?: (on: boolean) => void
  /** Menu-bar/notch strip height of the HUD's display (0 on plain screens). */
  getHudInsets?: () => Promise<{ topInset: number }>
  /** Screen awareness: downscaled JPEG still of the cursor's display. */
  captureScreen?: (opts?: { maxDim?: number }) => Promise<ScreenCaptureResult>
  /** Open macOS System Settings at Privacy & Security > Screen Recording. */
  openScreenRecordingSettings?: () => void
  /** Show + focus the main app window, optionally at a path (e.g. '/login'). */
  openMainWindow: (path?: string) => void
  getServerUrl: () => Promise<string>
  getStartupPrefs: () => Promise<StartupPrefs>
  /** Island Settings page surface. */
  getShellSettings?: () => Promise<ShellSettings | null>
  setShellSettings?: (patch: Partial<Pick<ShellSettings, 'hotkey' | 'launchAtLogin' | 'alwaysListening' | 'fileAccessEnabled'>> & { resourceMonitor?: Partial<ResourceMonitorSettings> }) => Promise<{ ok: boolean; error?: string }>
  getBattery?: () => Promise<BatteryStatus | null>
  /** Local machine stats + threshold alerts (island System tab / server reporter). */
  getResources?: () => Promise<ResourceState | null>
  ackResourceEvents?: (ids: string[]) => Promise<void>
  /** System output volume of the dock's machine (island Home page cluster). */
  volumeCommand?: (action: 'up' | 'down' | 'mute') => Promise<void>
  /** Read-only file access - enforced in the Electron main process. */
  fsRequest?: (req: { action: string; path: string }) => Promise<FsRequestResult>
  /** Native folder picker; returns the updated allowed roots. */
  fsPickFolder?: () => Promise<string[] | null>
  fsRemoveRoot?: (root: string) => Promise<string[] | null>
  fsRecentAccesses?: () => Promise<FsAccessEntry[]>
  openServerSetup?: () => void
  quitApp?: () => void
}

declare global {
  interface Window {
    lokiDesktop?: LokiDesktopBridge
  }
}

export {}
