// Wake-word model id → asset path registry. Ported from v2 + extended so trained
// per-character models (served by the backend) can be appended at runtime.
//
// All detectors share two upstream ONNX stages (mel + embedding); only the
// per-wake-word detector swaps. Pretrained detectors ship under public/wake-word/.

// Wakeword ONNX models are downloaded at runtime and served by the backend
// (data/voice/wakewords), not bundled in public/.
export const WAKE_WORD_ASSET_BASE = "/api/voice/wakeword"

export const SHARED_MEL_PATH = `${WAKE_WORD_ASSET_BASE}/melspectrogram.onnx`
export const SHARED_EMBEDDING_PATH = `${WAKE_WORD_ASSET_BASE}/embedding_model.onnx`

export interface WakeWordModelEntry {
  readonly id: string
  readonly displayName: string
  readonly assetPath: string
  readonly defaultThreshold: number
}

const ENTRIES: WakeWordModelEntry[] = [
  { id: "hey_jarvis", displayName: 'openWakeWord "hey jarvis"', assetPath: `${WAKE_WORD_ASSET_BASE}/hey_jarvis_v0.1.onnx`, defaultThreshold: 0.5 },
  { id: "alexa", displayName: 'openWakeWord "alexa"', assetPath: `${WAKE_WORD_ASSET_BASE}/alexa_v0.1.onnx`, defaultThreshold: 0.5 },
  { id: "hey_mycroft", displayName: 'openWakeWord "hey mycroft"', assetPath: `${WAKE_WORD_ASSET_BASE}/hey_mycroft_v0.1.onnx`, defaultThreshold: 0.5 },
]

const REGISTRY: Map<string, WakeWordModelEntry> = new Map(ENTRIES.map((e) => [e.id, e]))

/** Append trained/custom detectors (e.g. per-character models served by the backend). */
export function registerWakeWordModels(entries: WakeWordModelEntry[]): void {
  for (const e of entries) {
    if (!REGISTRY.has(e.id)) ENTRIES.push(e)
    REGISTRY.set(e.id, e)
  }
}

export function listWakeWordModels(): readonly WakeWordModelEntry[] {
  return ENTRIES
}

export function getWakeWordModel(id: string): WakeWordModelEntry {
  const entry = REGISTRY.get(id)
  if (!entry) throw new Error(`unknown wake-word model id: ${id}`)
  return entry
}

export const DEFAULT_WAKE_WORD_MODEL_ID = "hey_jarvis"

// Fetch the detectors actually installed on the backend and register them so the
// wake loop + pickers reflect what's downloaded. Safe to call repeatedly.
let loaded = false
let _coreInstalled: boolean | null = null

/** Whether the shared mel+embedding models are present on the server. Null until first fetch. */
export function getWakewordCoreInstalled(): boolean | null { return _coreInstalled }

export async function loadInstalledWakewords(force = false): Promise<WakeWordModelEntry[]> {
  if (loaded && !force) return ENTRIES
  try {
    const res = await fetch('/api/voice/wakewords', { credentials: 'include' })
    if (res.ok) {
      const data = (await res.json()) as { coreInstalled?: boolean; detectors: { id: string; label: string; defaultThreshold: number; assetUrl: string }[] }
      _coreInstalled = data.coreInstalled ?? false
      registerWakeWordModels(
        data.detectors.map((d) => ({ id: d.id, displayName: d.label, assetPath: d.assetUrl, defaultThreshold: typeof d.defaultThreshold === 'number' ? d.defaultThreshold : 0.5 })),
      )
      loaded = true
    }
  } catch { /* offline → keep built-in defaults */ }
  return ENTRIES
}
