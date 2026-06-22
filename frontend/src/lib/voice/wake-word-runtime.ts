// Lazy ONNX Runtime Web session loader for the wake-word pipeline. Ported from v2.
//
// Three ONNX sessions (mel · embedding · detector). mel + embedding are shared
// across detectors; only the detector handle swaps on model change. onnxruntime-web
// is imported lazily so non-voice users never pull the WASM artifacts.

export interface WakeWordInferenceSession {
  run(feeds: Record<string, WakeWordTensor>): Promise<Record<string, WakeWordTensor>>
}

export interface WakeWordTensor {
  readonly data: Float32Array | Int32Array | BigInt64Array
  readonly dims: readonly number[]
}

export interface SessionFactory {
  create(modelPath: string): Promise<WakeWordInferenceSession>
  tensor(data: Float32Array, dims: readonly number[]): WakeWordTensor
}

let factory: SessionFactory | null = null
const SESSIONS: Map<string, Promise<WakeWordInferenceSession>> = new Map()

export function setSessionFactory(next: SessionFactory | null): void {
  factory = next
  SESSIONS.clear()
}

export async function getOrLoadSession(modelPath: string): Promise<WakeWordInferenceSession> {
  const existing = SESSIONS.get(modelPath)
  if (existing) return existing
  const f = factory ?? (await loadDefaultFactory())
  const pending = f.create(modelPath)
  SESSIONS.set(modelPath, pending)
  return pending
}

export async function tensorFor(data: Float32Array, dims: readonly number[]): Promise<WakeWordTensor> {
  const f = factory ?? (await loadDefaultFactory())
  return f.tensor(data, dims)
}

export function evictSession(modelPath: string): void {
  SESSIONS.delete(modelPath)
}

export function evictAllSessions(): void {
  SESSIONS.clear()
}

let defaultLoading: Promise<SessionFactory> | null = null

async function loadDefaultFactory(): Promise<SessionFactory> {
  if (defaultLoading) return defaultLoading
  defaultLoading = (async () => {
    const ort = await import("onnxruntime-web")
    // Bundle-served WASM: see frontend/public/ort/. No CDN (offline-first).
    ort.env.wasm.wasmPaths = "/ort/"
    ort.env.wasm.numThreads = 1
    const built: SessionFactory = {
      async create(modelPath: string): Promise<WakeWordInferenceSession> {
        const session = await ort.InferenceSession.create(modelPath, { executionProviders: ["wasm"] })
        return {
          async run(feeds: Record<string, WakeWordTensor>) {
            const ortFeeds: Record<string, InstanceType<typeof ort.Tensor>> = {}
            for (const [name, t] of Object.entries(feeds)) {
              ortFeeds[name] = new ort.Tensor("float32", t.data as Float32Array, t.dims as number[])
            }
            const out = await session.run(ortFeeds)
            const result: Record<string, WakeWordTensor> = {}
            for (const [name, tensor] of Object.entries(out)) {
              result[name] = { data: tensor.data as Float32Array, dims: tensor.dims }
            }
            return result
          },
        }
      },
      tensor(data: Float32Array, dims: readonly number[]): WakeWordTensor {
        return { data, dims }
      },
    }
    factory = built
    return built
  })()
  return defaultLoading
}
