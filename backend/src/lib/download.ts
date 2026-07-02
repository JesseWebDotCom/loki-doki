import { existsSync, statSync, chmodSync, createWriteStream, createReadStream, openSync, readSync, closeSync, unlinkSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve, basename, isAbsolute } from 'node:path'
import { spawn, execSync } from 'node:child_process'
import { CATALOG } from '@/lib/catalog'
import type { HfSource, CatalogModel } from '@/lib/catalog'
import { getAppSetting } from '@/lib/settings'
import { IS_WIN, extractZip } from '@/lib/platform'
import type { ComfyUILaunchConfig } from '@/lib/hwfit'

const ollamaBase = () => (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '')

export const dataDir = resolve(process.cwd(), '../data')

export interface DownloadProgress {
  completed: number
  total: number
  speedBps: number
  etaSeconds: number
  status?: string
}

// A streamed download that delivers no bytes for this long is treated as hung: the read is
// raced against a timer so a silently-stalled connection (socket alive, mirror frozen)
// rejects instead of blocking forever. Resumable downloads (.part) just retry from disk.
export const STREAM_IDLE_TIMEOUT_MS = 90_000

/** Race a stream read against an idle timeout. Rejects if no chunk arrives within `idleMs`,
 *  turning a silently-hung connection into a retriable error instead of an infinite hang. */
export async function readWithIdleTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  idleMs: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Download stalled: no data for ${Math.round(idleMs / 1000)}s`)), idleMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ── Safetensors validation ────────────────────────────────────────────────────
// Validates that a .safetensors file's header is complete AND that all described
// tensor byte ranges fit within the actual file size — identical to the check
// Python's safetensors library performs, so a corrupt file is caught here rather
// than surfacing as a cryptic ComfyUI execution_error at generation time.

export function validateSafetensorsFile(filePath: string): boolean {
  try {
    const size = statSync(filePath).size
    if (size < 8) return false
    const fd = openSync(filePath, 'r')
    const lenBuf = Buffer.allocUnsafe(8)
    readSync(fd, lenBuf, 0, 8, 0)
    const headerLen = Number(lenBuf.readBigUInt64LE(0))
    // Sanity-cap: no legitimate model header exceeds 64 MB
    if (headerLen > 64 * 1024 * 1024 || size < 8 + headerLen) { closeSync(fd); return false }
    const headerBuf = Buffer.allocUnsafe(headerLen)
    readSync(fd, headerBuf, 0, headerLen, 8)
    closeSync(fd)
    // Parse tensor descriptors — each has data_offsets: [start, end]; find max end.
    const header = JSON.parse(headerBuf.toString('utf8')) as Record<string, unknown>
    let maxOffset = 0
    for (const val of Object.values(header)) {
      if (typeof val !== 'object' || val === null) continue
      const offsets = (val as Record<string, unknown>)['data_offsets']
      if (Array.isArray(offsets) && offsets.length >= 2) {
        const end = offsets[1] as number
        if (end > maxOffset) maxOffset = end
      }
    }
    return size >= 8 + headerLen + maxOffset
  } catch {
    return false
  }
}

// ── Generic URL download with resume support ──────────────────────────────────
// Checks for a .part file and sends Range header to resume interrupted downloads.
// Skips entirely if the destination file already exists.

export interface DownloadUrlOptions {
  /** Verify the completed file's SHA-256 (lowercase hex). Mismatch deletes the file and throws. */
  expectedSha256?: string
  /** Reject completed files smaller than this — catches error pages saved as binaries. */
  minBytes?: number
  /** Extra request headers (e.g. auth tokens). */
  headers?: Record<string, string>
}

export function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

// Post-download integrity gate. `expectedTotal` comes from Content-Length (0 = server
// didn't say); a size mismatch means a truncated/overlong body that TCP happily
// delivered — without this it only surfaces later as a corrupt model/binary.
// Any failure deletes the file so the retry starts clean instead of resuming garbage.
async function verifyDownloadedFile(
  destPath: string,
  expectedTotal: number,
  opts: DownloadUrlOptions | undefined,
  onProgress: (p: DownloadProgress) => void,
): Promise<void> {
  const fail = (reason: string): never => {
    try { unlinkSync(destPath) } catch { /* already gone */ }
    throw new Error(`Download verification failed (${reason}): ${basename(destPath)} — the file was removed and will be re-downloaded`)
  }
  const size = statSync(destPath).size
  if (expectedTotal > 0 && size !== expectedTotal) fail(`size ${size} != expected ${expectedTotal}`)
  if (opts?.minBytes && size < opts.minBytes) fail(`only ${size} bytes`)
  if (opts?.expectedSha256) {
    onProgress({ completed: size, total: size, speedBps: 0, etaSeconds: 0, status: 'Verifying checksum…' })
    const actual = await sha256OfFile(destPath)
    if (actual !== opts.expectedSha256.toLowerCase()) fail(`sha256 ${actual.slice(0, 12)}… != expected ${opts.expectedSha256.slice(0, 12)}…`)
  }
}

// Serializes downloads of the same destination so two concurrent callers (e.g. a
// re-fired install effect or a retry) don't race on the shared `.part` file and
// crash when one renames it to the final path before the other.
const downloadLocks = new Map<string, Promise<unknown>>()

// Retry transient network errors with backoff. The .part file means each retry
// resumes rather than restarting — so a 4 GB file interrupted at 3.9 GB costs
// only the last few hundred MB on retry, not the whole download.
// Lock-free inner loop: callers must already hold the downloadLocks entry.
async function downloadUrlUnlocked(
  url: string,
  destRelative: string,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
  opts?: DownloadUrlOptions,
): Promise<void> {
  const MAX_ATTEMPTS = 6
  for (let attempt = 1; ; attempt++) {
    try {
      await _downloadUrlImpl(url, destRelative, onProgress, signal, opts)
      return
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      if (attempt >= MAX_ATTEMPTS) throw err
      const msg = String(err)
      if (msg.includes('(404)') || msg.includes('(403)')) throw err  // auth / not-found → don't retry
      const delaySec = Math.min(5 * 2 ** (attempt - 1), 60)
      onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: delaySec, status: `Connection interrupted — resuming in ${delaySec}s… (${attempt}/${MAX_ATTEMPTS - 1})` })
      await new Promise<void>((r) => setTimeout(r, delaySec * 1000))
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
    }
  }
}

export async function downloadUrl(
  url: string,
  destRelative: string,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
  opts?: DownloadUrlOptions,
): Promise<void> {
  while (downloadLocks.has(destRelative)) {
    try { await downloadLocks.get(destRelative) } catch { /* ignore a prior attempt's failure; we re-check below */ }
  }
  const p = downloadUrlUnlocked(url, destRelative, onProgress, signal, opts)
  downloadLocks.set(destRelative, p)
  try { await p } finally { if (downloadLocks.get(destRelative) === p) downloadLocks.delete(destRelative) }
}

function throwIfCorruptSafetensors(destPath: string): void {
  if (!destPath.endsWith('.safetensors')) return
  if (!validateSafetensorsFile(destPath)) {
    try { unlinkSync(destPath) } catch { /* already gone */ }
    throw new Error(`Downloaded .safetensors file is incomplete — the download was interrupted. It has been removed and will be retried automatically: ${basename(destPath)}`)
  }
}

async function _downloadUrlImpl(
  url: string,
  destRelative: string,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
  opts?: DownloadUrlOptions,
): Promise<void> {
  // Accepts either a path relative to data/ (the common case) or an absolute path,
  // so installers whose targets live elsewhere under data/ can share this machinery.
  const destPath = isAbsolute(destRelative) ? destRelative : join(dataDir, destRelative)
  const partPath = destPath + '.part'

  await mkdir(dirname(destPath), { recursive: true })

  // Already fully downloaded — nothing to do
  if (existsSync(destPath)) {
    const size = statSync(destPath).size
    onProgress({ completed: size, total: size, speedBps: 0, etaSeconds: 0 })
    return
  }

  // Check for a partial download to resume
  let resumeFrom = 0
  try { resumeFrom = statSync(partPath).size } catch { /* no partial */ }

  const headers: Record<string, string> = { ...opts?.headers }
  if (resumeFrom > 0) headers['Range'] = `bytes=${resumeFrom}-`

  const res = await fetch(url, { signal, headers })

  // 416 = the server says we already have everything
  if (res.status === 416) {
    try { await rename(partPath, destPath) } catch (e) { if (!existsSync(destPath)) throw e }
    await verifyDownloadedFile(destPath, 0, opts, onProgress)
    throwIfCorruptSafetensors(destPath)
    return
  }

  if (!res.ok && res.status !== 206) {
    throw new Error(`Download failed (${res.status}): ${url}`)
  }
  if (!res.body) throw new Error('No response body')

  const isPartial = res.status === 206
  const contentLength = parseInt(res.headers.get('content-length') ?? '0', 10)
  const total = isPartial ? resumeFrom + contentLength : contentLength
  // Content-Length describes the WIRE bytes; fetch auto-decompresses, so when the
  // server content-encoded the body (gzip/br — small text files, not model weights)
  // the on-disk size legitimately differs and the size check must be skipped.
  const wireEncoded = !!res.headers.get('content-encoding')

  const reader = res.body.getReader()
  const fileStream = createWriteStream(partPath, { flags: isPartial ? 'a' : 'w' })

  let completed = isPartial ? resumeFrom : 0
  let lastTime = Date.now()
  let lastBytes = completed

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
      const { done, value } = await readWithIdleTimeout(reader, STREAM_IDLE_TIMEOUT_MS)
      if (done) break

      fileStream.write(value)
      completed += value.length

      const now = Date.now()
      const elapsed = (now - lastTime) / 1000
      if (elapsed >= 0.5 || completed >= total) {
        const speedBps   = elapsed > 0 ? (completed - lastBytes) / elapsed : 0
        const etaSeconds = speedBps > 0 ? (total - completed) / speedBps : 0
        onProgress({ completed, total, speedBps, etaSeconds })
        lastTime  = now
        lastBytes = completed
      }
    }
    await new Promise<void>((res, rej) =>
      fileStream.end((err?: Error | null) => (err ? rej(err) : res())),
    )
    try { await rename(partPath, destPath) } catch (e) { if (!existsSync(destPath)) throw e }
    // Only enforce the size check when the server declared a length for the raw bytes.
    await verifyDownloadedFile(destPath, contentLength > 0 && !wireEncoded ? total : 0, opts, onProgress)
    throwIfCorruptSafetensors(destPath)
  } catch (err) {
    fileStream.destroy()
    throw err
  } finally {
    // Release the body reader on abort/error so the underlying connection isn't
    // left half-read and leaked (the reader holds a lock on res.body otherwise).
    try { await reader.cancel() } catch { /* already closed */ }
  }
}

// ── Ollama pull ───────────────────────────────────────────────────────────────

async function _pullOllamaStream(
  tag: string,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${ollamaBase()}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: tag, stream: true }),
    signal,
  })

  if (!res.ok || !res.body) throw new Error(`Ollama pull failed: ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let lastTime  = Date.now()
  let lastBytes = 0
  let lastSpeedBps   = 0
  let lastEtaSeconds = 0
  let lastEmitTime   = 0

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')

      const { done, value } = await readWithIdleTimeout(reader, STREAM_IDLE_TIMEOUT_MS)
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue
        let chunk: { status: string; total?: number; completed?: number; error?: string }
        try {
          chunk = JSON.parse(line)
        } catch {
          continue // skip malformed JSON lines
        }

        if (chunk.error) throw new Error(chunk.error)

        const total     = chunk.total     ?? 0
        const completed = chunk.completed ?? 0

        if (total > 0) {
          const now     = Date.now()
          const elapsed = (now - lastTime) / 1000
          if (elapsed >= 0.5) {
            lastSpeedBps   = elapsed > 0 ? (completed - lastBytes) / elapsed : 0
            lastEtaSeconds = lastSpeedBps > 0 ? (total - completed) / lastSpeedBps : 0
            lastTime  = now
            lastBytes = completed
          }
          // Throttle SSE emissions to ~2 per second to prevent frontend flashing
          if (now - lastEmitTime >= 500 || completed >= total) {
            onProgress({ completed, total, speedBps: lastSpeedBps, etaSeconds: lastEtaSeconds, status: chunk.status })
            lastEmitTime = now
          }
        } else {
          onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: 0, status: chunk.status })
        }
      }
    }
  } finally {
    // Release the body reader on abort/error so the streamed connection isn't leaked.
    try { await reader.cancel() } catch { /* already closed */ }
  }
}

// Wraps _pullOllamaStream with automatic retry + exponential backoff. Ollama
// layer-downloads resume internally, so each retry picks up where it left off.
// Non-retriable errors (404, model not found) are re-thrown immediately.
export async function pullOllama(
  tag: string,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const MAX_ATTEMPTS = 8
  for (let attempt = 1; ; attempt++) {
    try {
      await _pullOllamaStream(tag, onProgress, signal)
      return
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      if (attempt >= MAX_ATTEMPTS) throw err
      // Non-retriable: model doesn't exist on the registry
      const msg = String(err).toLowerCase()
      if (msg.includes(' 404') || msg.includes('not found') || msg.includes('does not exist') || msg.includes('file does not exist')) throw err
      // Transient network error — wait with exponential backoff, then retry.
      // Ollama layer state is preserved across calls so the next attempt resumes.
      const delaySec = Math.min(5 * 2 ** (attempt - 1), 120)
      onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: delaySec, status: `Connection interrupted — retrying in ${delaySec}s… (${attempt}/${MAX_ATTEMPTS - 1})` })
      await new Promise<void>((r) => setTimeout(r, delaySec * 1000))
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
    }
  }
}

// ── Large-file download with aria2 acceleration ───────────────────────────────
// Files at/above this size get 16-segment parallel download via aria2 when available
// (HuggingFace/GitHub/CivitAI all honor Range) — typically 3-5× faster than one TCP
// flow against a throttling CDN. Falls back to the plain resumable stream when aria2
// is missing or fails. An in-progress single-stream .part sticks with single-stream
// so its bytes aren't thrown away; likewise an aria2 .aria2 control file resumes aria2.
const ARIA2_MIN_BYTES = 1024 ** 3  // 1 GB

export async function downloadLargeUrl(
  url: string,
  destRelative: string,
  approxBytes: number,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
  opts?: DownloadUrlOptions,
): Promise<void> {
  const destPath = isAbsolute(destRelative) ? destRelative : join(dataDir, destRelative)
  const ctrlPath = destPath + '.aria2'

  // Serialize against other downloads of the same destination (same rule as downloadUrl).
  while (downloadLocks.has(destRelative)) {
    try { await downloadLocks.get(destRelative) } catch { /* prior attempt failed; re-check below */ }
  }
  const run = async () => {
    // Complete already? An .aria2 control file next to the dest means aria2 was
    // interrupted mid-write — the file LOOKS complete but isn't.
    if (existsSync(destPath) && !existsSync(ctrlPath)) {
      const size = statSync(destPath).size
      onProgress({ completed: size, total: size, speedBps: 0, etaSeconds: 0 })
      return
    }

    const wantAria2 = (approxBytes >= ARIA2_MIN_BYTES || existsSync(ctrlPath)) && !existsSync(destPath + '.part')
    if (wantAria2) {
      try {
        const { ensureAria2, downloadFileWithAria2 } = await import('@/lib/aria2')
        const bin = await ensureAria2()
        if (bin) {
          await downloadFileWithAria2(bin, url, destPath, approxBytes, onProgress, signal, opts?.expectedSha256)
          // aria2 already verified the sha256 (--checksum); still enforce size floors.
          await verifyDownloadedFile(destPath, 0, { ...opts, expectedSha256: undefined }, onProgress)
          throwIfCorruptSafetensors(destPath)
          return
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') throw err
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
        // aria2 path failed — clear its partial state so the single-stream fallback
        // doesn't mistake the incomplete file for a finished download.
        try { unlinkSync(destPath) } catch { /* not created */ }
        try { unlinkSync(ctrlPath) } catch { /* not created */ }
        onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: 0, status: 'Accelerated download unavailable — using standard download…' })
      }
    }
    // Unlocked variant — we already hold the downloadLocks entry for this dest.
    await downloadUrlUnlocked(url, destRelative, onProgress, signal, opts)
  }
  const p = run()
  downloadLocks.set(destRelative, p)
  try { await p } finally { if (downloadLocks.get(destRelative) === p) downloadLocks.delete(destRelative) }
}

// ── HuggingFace file download ─────────────────────────────────────────────────

// For LFS-stored files (every model weight), HuggingFace's resolve endpoint returns
// the file's SHA-256 as `x-linked-etag` on the pre-redirect response — a free,
// authoritative checksum. Non-LFS files return a git blob hash (40 hex) instead,
// which we ignore. Best-effort: any failure just means no checksum verification.
export async function hfFileSha256(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(15_000) })
    const etag = res.headers.get('x-linked-etag') ?? res.headers.get('etag')
    const m = etag?.match(/^(?:W\/)?"?([a-f0-9]{64})"?$/i)
    return m?.[1] ? m[1].toLowerCase() : null
  } catch {
    return null
  }
}

export async function downloadHfFile(
  hf: HfSource,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
  approxBytes?: number,
): Promise<void> {
  const url = `https://huggingface.co/${hf.repo}/resolve/main/${hf.file}`
  const destPath = join(dataDir, hf.dest)
  // Skip the HEAD round-trip when the file is already on disk (downloadUrl no-ops).
  const expectedSha256 = existsSync(destPath) ? undefined : (await hfFileSha256(url)) ?? undefined
  await downloadLargeUrl(url, hf.dest, approxBytes ?? hf.approxBytes ?? 0, onProgress, signal, { expectedSha256 })
}

// ── sd.cpp (image generation runtime) ─────────────────────────────────────────

export const SD_BIN_DEST     = 'bin/sd'
export const SD_APPROX_BYTES = 25_000_000  // ~25 MB binary

// FLUX.2 VAE — 32 latent channels, required for FLUX.2 models.
// Publicly available via Comfy-Org/flux2-dev (no HuggingFace auth required).
export const FLUX_VAE_DEST         = 'models/flux/flux2-vae.safetensors'
export const FLUX_VAE_APPROX_BYTES = 335_000_000  // ~335 MB

// Qwen3-8B text encoder for FLUX.2 Klein — shared by 4B and 9B UNet variants.
export const FLUX_KLEIN_TE_DEST = 'models/flux/Qwen3-8B-Q4_K_S.gguf'

export function getFluxKleinTePath(): string | null {
  const p = join(dataDir, FLUX_KLEIN_TE_DEST)
  return existsSync(p) ? p : null
}

export async function downloadFluxVae(
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const url = 'https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors'
  await downloadUrl(url, FLUX_VAE_DEST, onProgress, signal)
}

export function getFluxVaePath(): string | null {
  const p = join(dataDir, FLUX_VAE_DEST)
  return existsSync(p) ? p : null
}

async function getSdCppDownloadUrl(): Promise<string> {
  // Walk recent releases, not just /latest: sd.cpp occasionally ships a release
  // without the macOS asset (or renames it), and pinning on /latest alone made
  // install fail outright until upstream fixed their release.
  const res = await fetch(
    'https://api.github.com/repos/leejet/stable-diffusion.cpp/releases?per_page=5',
    {
      headers: { 'User-Agent': 'loki-doki/1.0', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10_000),
    },
  )
  if (!res.ok) throw new Error(`GitHub API ${res.status} fetching sd.cpp releases`)
  const releases = await res.json() as { assets: { name: string; browser_download_url: string }[] }[]
  for (const release of releases) {
    // macOS ARM64 Metal build: "sd-master-[hash]-bin-Darwin-...-arm64.zip" (or legacy "bin-osx-arm64.zip")
    const asset = release.assets?.find(
      (a) => (a.name.includes('Darwin') || a.name.includes('osx')) && a.name.includes('arm64') && a.name.endsWith('.zip'),
    )
    if (asset) return asset.browser_download_url
  }
  throw new Error('No macOS ARM64 sd.cpp asset found in the last 5 releases')
}

export async function downloadSdCppBinary(
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const binPath  = join(dataDir, SD_BIN_DEST)
  const binDir   = join(dataDir, 'bin')
  const dylibPath = join(binDir, 'libstable-diffusion.dylib')

  // Re-download if binary exists but the required dylib is missing (incomplete prior extraction).
  if (existsSync(binPath) && !existsSync(dylibPath)) {
    await rm(binPath, { force: true })
  }

  if (existsSync(binPath)) {
    const size = statSync(binPath).size
    onProgress({ completed: size, total: size, speedBps: 0, etaSeconds: 0 })
    return
  }

  const url        = await getSdCppDownloadUrl()
  const zipDest    = 'downloads/sd-darwin.zip'
  const zipPath    = join(dataDir, zipDest)
  const extractDir = join(dataDir, 'downloads/sd-extract')

  await downloadUrl(url, zipDest, onProgress, signal)
  execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { timeout: 30_000 })

  // Prefer sd-server (HTTP server binary) over sd (CLI-only)
  let sdBin = execSync(
    `find "${extractDir}" -type f -name "sd-server" 2>/dev/null | head -1`,
    { encoding: 'utf8', timeout: 5_000 },
  ).trim()
  if (!sdBin) {
    sdBin = execSync(
      `find "${extractDir}" -type f -name "sd" 2>/dev/null | head -1`,
      { encoding: 'utf8', timeout: 5_000 },
    ).trim()
  }
  if (!sdBin) throw new Error('Could not find sd binary in sd.cpp release archive')

  await mkdir(binDir, { recursive: true })
  execSync(`cp "${sdBin}" "${binPath}"`)
  chmodSync(binPath, 0o755)

  // Copy any dynamic libraries (.dylib) the binary needs into the same bin/ dir.
  const dylibLines = execSync(
    `find "${extractDir}" -type f -name "*.dylib" 2>/dev/null`,
    { encoding: 'utf8', timeout: 5_000 },
  ).trim()
  for (const dylib of dylibLines.split('\n').filter(Boolean)) {
    execSync(`cp "${dylib}" "${join(binDir, basename(dylib))}"`)
  }

  await rm(extractDir, { recursive: true, force: true })
  await rm(zipPath, { force: true })
}

export function spawnSdCpp(modelPath: string, vaePath?: string | null, llmPath?: string | null): void {
  const binPath = join(dataDir, SD_BIN_DEST)
  if (!existsSync(binPath) || !existsSync(modelPath)) return
  const loraDir = join(dataDir, 'loras')
  const binDir  = join(dataDir, 'bin')
  const args = [
    '--diffusion-model', modelPath,
    '--lora-model-dir', loraDir,
    '--listen-port', '8080',
    '--listen-ip', '127.0.0.1',
  ]
  if (vaePath && existsSync(vaePath)) {
    args.push('--vae', vaePath)
  }
  // FLUX.2 Klein uses Qwen3-8B as text encoder (--llm), not CLIP-L/T5-XXL.
  if (llmPath && existsSync(llmPath)) {
    args.push('--llm', llmPath)
  }
  spawn(binPath, args, {
    detached: true,
    stdio: 'ignore',
    // Required so the binary can find libstable-diffusion.dylib next to it in data/bin/
    env: { ...process.env, DYLD_LIBRARY_PATH: binDir },
  }).unref()
}

export async function getImageModelPath(): Promise<string | null> {
  try {
    const modelId = (await getAppSetting('image_model')) as string | null
    if (!modelId) return null
    const model = CATALOG.find((m) => m.id === modelId && m.role === 'image_gen')
    if (!model?.hf) return null
    const p = join(dataDir, model.hf.dest)
    return existsSync(p) ? p : null
  } catch {
    return null
  }
}

/** Returns the HF source + full dest path for the image model, whether the file
 *  is complete, partial (.part), or missing. Returns null if no image model is set. */
export async function getImageModelInfo(): Promise<{
  hf: HfSource
  fullPath: string
  complete: boolean
  partial: boolean
} | null> {
  try {
    const modelId = (await getAppSetting('image_model')) as string | null
    if (!modelId) return null
    const model = CATALOG.find((m) => m.id === modelId && m.role === 'image_gen')
    if (!model?.hf) return null
    const fullPath = join(dataDir, model.hf.dest)
    const complete = existsSync(fullPath)
    const partial  = !complete && existsSync(fullPath + '.part')
    return { hf: model.hf, fullPath, complete, partial }
  } catch {
    return null
  }
}

// ── Ollama binary install ─────────────────────────────────────────────────────
// macOS ships Ollama-darwin.zip (the .app bundle). The CLI binary lives inside:
//   Ollama.app/Contents/Resources/ollama  (most versions)
//   Ollama.app/Contents/MacOS/ollama      (fallback)

// Per-platform Ollama release asset:
//   macOS   → Ollama-darwin.zip (the .app bundle; CLI lives inside Resources/)
//   Windows → ollama-windows-amd64.zip (ollama.exe + lib/ollama runners)
//   Linux   → ollama-linux-amd64 (bare binary)
const OLLAMA_ZIP_URL =
  process.platform === 'darwin'
    ? 'https://github.com/ollama/ollama/releases/latest/download/Ollama-darwin.zip'
    : IS_WIN
      ? 'https://github.com/ollama/ollama/releases/latest/download/ollama-windows-amd64.zip'
      : 'https://github.com/ollama/ollama/releases/latest/download/ollama-linux-amd64'

const OLLAMA_ZIP_DEST = IS_WIN ? 'downloads/ollama-windows.zip' : 'downloads/Ollama-darwin.zip'
export const OLLAMA_BIN_DEST = IS_WIN ? 'bin/ollama.exe' : 'bin/ollama'
export const OLLAMA_BIN_APPROX_BYTES = 90_000_000  // ~90 MB zip
export const OLLAMA_WINDOWS_INSTALL_MESSAGE =
  'Ollama is required and must be installed manually on Windows. Download it from https://ollama.com/download — it starts automatically once installed, and setup will continue.'

// Standard locations where Ollama is pre-installed (macOS app, Windows installer, or Linux package)
const SYSTEM_OLLAMA_CANDIDATES = IS_WIN
  ? ([
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'),  // default per-user installer
      process.env.ProgramFiles && join(process.env.ProgramFiles, 'Ollama', 'ollama.exe'),
      process.env.ProgramW6432 && join(process.env.ProgramW6432, 'Ollama', 'ollama.exe'),
    ].filter(Boolean) as string[])
  : [
      '/opt/homebrew/bin/ollama',   // Homebrew (Apple Silicon) — was missing
      '/usr/local/bin/ollama',      // Homebrew (Intel) / manual install
      '/Applications/Ollama.app/Contents/Resources/ollama',
      '/usr/bin/ollama',
    ]

export function findSystemOllama(): string | null {
  return SYSTEM_OLLAMA_CANDIDATES.find(existsSync) ?? null
}

// A single companion turn touches four models (chat, router LLM, and two embed
// models) and vision makes five. Ollama's default keeps only 3 loaded, so every
// turn evicted the biggest model (the 8B chat model) and paid a measured ~930ms
// reload plus total KV-cache loss on the next call. All five fit in ~12GB.
export function ollamaServeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OLLAMA_MAX_LOADED_MODELS: process.env.OLLAMA_MAX_LOADED_MODELS ?? '6',
  }
}

export async function downloadAndStartOllama(
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const base = ollamaBase()

  // If Ollama is already running, nothing to do
  try {
    const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(2_000) })
    if (r.ok) { onProgress({ completed: 1, total: 1, speedBps: 0, etaSeconds: 0 }); return }
  } catch { /* not running */ }

  // Prefer system-installed Ollama over our extracted binary — the system
  // installation ships with all required runner binaries (llama-server, etc.)
  const systemBin = findSystemOllama()
  if (systemBin) {
    spawn(systemBin, ['serve'], { detached: true, stdio: 'ignore', env: ollamaServeEnv() }).unref()
  } else {
    // Fall back to downloading only when no system Ollama exists
    const binPath = join(dataDir, OLLAMA_BIN_DEST)
    if (!existsSync(binPath)) {
      if (process.platform === 'darwin') {
        await downloadUrl(OLLAMA_ZIP_URL, OLLAMA_ZIP_DEST, onProgress, signal)
        const zipPath    = join(dataDir, OLLAMA_ZIP_DEST)
        const extractDir = join(dataDir, 'downloads/ollama-extract')
        extractZip(zipPath, extractDir, 60_000)
        await mkdir(join(dataDir, 'bin'), { recursive: true })
        // Copy the FULL runtime, not just the CLI: modern Ollama loads models via a
        // separate `lib/ollama/llama-server` runner. Copying only the `ollama` binary
        // yields one that errors "llama-server binary not found" on every request.
        const resourcesDir = join(extractDir, 'Ollama.app/Contents/Resources')
        const macosDir     = join(extractDir, 'Ollama.app/Contents/MacOS')
        if (existsSync(resourcesDir)) {
          execSync(`cp -R "${resourcesDir}/." "${join(dataDir, 'bin')}/"`, { timeout: 120_000 })
        }
        if (!existsSync(binPath) && existsSync(join(macosDir, 'ollama'))) {
          execSync(`cp "${join(macosDir, 'ollama')}" "${binPath}"`)
        }
        if (!existsSync(binPath)) throw new Error('Could not locate ollama binary inside Ollama.app')
        chmodSync(binPath, 0o755)
        await rm(extractDir, { recursive: true, force: true })
        await rm(zipPath, { force: true })
      } else if (IS_WIN) {
        // On Windows we don't auto-install: the official installer registers Ollama as an
        // auto-starting service and is far more reliable than unpacking the standalone zip.
        // Surface an actionable error; the wizard already prompts the user up front.
        throw new Error(OLLAMA_WINDOWS_INSTALL_MESSAGE)
      } else {
        await downloadUrl(OLLAMA_ZIP_URL, OLLAMA_BIN_DEST, onProgress, signal)
        chmodSync(binPath, 0o755)
      }
    }
    spawn(binPath, ['serve'], { detached: true, stdio: 'ignore', env: ollamaServeEnv() }).unref()
  }

  // Wait for Ollama to become responsive, emitting indeterminate status each second
  // so the UI shows "Starting server…" instead of looking frozen.
  for (let i = 0; i < 30; i++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
    onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: 0, status: 'Starting server…' })
    await new Promise((r) => setTimeout(r, 1000))
    try {
      const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) })
      if (r.ok) return
    } catch { /* not up yet */ }
  }
  throw new Error('Ollama failed to start within 30 seconds')
}

// ── Direct-URL download (CivitAI, etc.) ───────────────────────────────────────
// Public models on CivitAI download without auth:
//   https://civitai.com/api/download/models/{versionId}

export async function downloadDirectUrl(
  url: string,
  dest: string,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  await downloadUrl(url, dest, onProgress, signal)
}

// ── TAESD preview models ──────────────────────────────────────────────────────
// Tiny AutoEncoder for Stable Diffusion — provides per-step latent previews
// during image generation. Files are ~5 MB each, stored in vae_approx/ so
// ComfyUI can find them with --preview-method auto (tries taesd first).

const TAESD_BASE = 'https://github.com/madebyollin/taesd/raw/main'
const TAESD_FILES = [
  { url: `${TAESD_BASE}/taesd_decoder.pth`,   dest: 'comfyui/models/vae_approx/taesd_decoder.pth' },
  { url: `${TAESD_BASE}/taesdxl_decoder.pth`, dest: 'comfyui/models/vae_approx/taesdxl_decoder.pth' },
]

export function isTaesdInstalled(): boolean {
  return TAESD_FILES.every(f => existsSync(join(dataDir, f.dest)))
}

export async function downloadTaesdModels(
  onProgress: (p: DownloadProgress & { label: string }) => void,
  signal?: AbortSignal,
): Promise<void> {
  for (const f of TAESD_FILES) {
    if (existsSync(join(dataDir, f.dest))) continue
    const name = f.dest.split('/').pop()!
    onProgress({ label: `Downloading ${name}…`, completed: 0, total: 0, speedBps: 0, etaSeconds: 0 })
    await downloadUrl(f.url, f.dest, (p) => onProgress({ ...p, label: `Downloading ${name}…` }), signal)
  }
}

// ── SDXL external VAE ─────────────────────────────────────────────────────────
// The SDXL 1.0 base checkpoint ships with incorrect v0.9 VAE weights, causing
// color fringing/chromatic aberration. The official stabilityai VAE fixes this
// but overflows in fp16 on MPS (Apple Silicon) → NaN / black images.
// madebyollin's fp16-fix variant is numerically stable at fp16/bfloat16 and is
// the correct choice for ComfyUI on Apple Silicon (MPS backend).

const SDXL_VAE_URL       = 'https://huggingface.co/madebyollin/sdxl-vae-fp16-fix/resolve/main/sdxl_vae.safetensors'
export const SDXL_VAE_DEST = 'comfyui/models/vae/sdxl_vae.safetensors'

export function isSdxlVaeInstalled(): boolean {
  return existsSync(join(dataDir, SDXL_VAE_DEST))
}

export async function downloadSdxlVae(
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  await downloadUrl(SDXL_VAE_URL, SDXL_VAE_DEST, onProgress, signal)
}

// ── ESRGAN upscale model ──────────────────────────────────────────────────────
// 4x-NMKD-Siax_200k: recommended upscaler for Juggernaut XL (CivitAI creator).
// Used in pixel-space hires fix: decode base → ESRGAN 4x → resize to 2x target
// → re-encode → hires KSampler at denoise 0.30. Produces sharper detail than
// latent bislerp interpolation.

const ESRGAN_URL  = 'https://huggingface.co/uwg/upscaler/resolve/main/ESRGAN/4x_NMKD-Siax_200k.pth'
const ESRGAN_DEST = 'comfyui/models/upscale_models/4x_NMKD-Siax_200k.pth'

export function isEsrganInstalled(): boolean {
  return existsSync(join(dataDir, ESRGAN_DEST))
}

export async function downloadEsrganModel(
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  await downloadUrl(ESRGAN_URL, ESRGAN_DEST, onProgress, signal)
}

// ── Podcast stinger SoundFont ────────────────────────────────────────────────
// GeneralUser GS — a high-quality, permissively-licensed General MIDI SoundFont
// (free to use and redistribute; see https://github.com/mrbumpy409/GeneralUser-GS).
// The client-side stinger generator (spessasynth_core) renders believable
// multi-instrument intro/outro music from this entirely offline. ~32 MB, one-time.
const STINGER_SF_URL  = 'https://github.com/mrbumpy409/GeneralUser-GS/raw/main/GeneralUser-GS.sf2'
const STINGER_SF_DEST = 'audio/soundfonts/GeneralUser-GS.sf2'

export function stingerSoundfontPath(): string {
  return join(dataDir, STINGER_SF_DEST)
}

export function isStingerSoundfontInstalled(): boolean {
  return existsSync(stingerSoundfontPath())
}

export async function downloadStingerSoundfont(
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  await downloadUrl(STINGER_SF_URL, STINGER_SF_DEST, onProgress, signal)
}

let stingerSfPromise: Promise<string> | null = null
/** Resolve the SoundFont path, downloading it on first use (mirrors ensureFfmpeg).
 *  Records it in the install ledger so boot reconcile keeps it repaired thereafter.
 *  This is what makes a fresh install "just work" the first time the stinger picker
 *  opens — no manual setup step required. */
export async function ensureStingerSoundfont(): Promise<string> {
  if (isStingerSoundfontInstalled()) return stingerSoundfontPath()
  if (!stingerSfPromise) {
    stingerSfPromise = (async () => {
      await downloadStingerSoundfont(() => {})
      // Dynamic import avoids a static cycle (installRegistry imports this module).
      try { const { recordInstalled } = await import('@/lib/installRegistry'); await recordInstalled('podcast-stinger-sf') }
      catch { /* ledger is best-effort */ }
      return stingerSoundfontPath()
    })().catch((e) => { stingerSfPromise = null; throw e })
  }
  return stingerSfPromise
}

// ── OpenWakeWord models ─────────────────────────────────────────────────────
// Downloaded into data/voice/wakewords and served by /api/voice/wakeword/:file
// (runtime-downloaded → can't live in frontend/public). The shared mel+embedding
// feature models are required by every detector; one default detector ships with
// the core so wake works out of the box. The wakeword browser adds more.
const OWW_BASE = 'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1'
export const WAKEWORD_DIR_REL = 'voice/wakewords'
const WAKEWORD_SHARED = ['melspectrogram.onnx', 'embedding_model.onnx']
const WAKEWORD_DEFAULT_DETECTOR = 'hey_jarvis_v0.1.onnx'

export function wakewordDir(): string {
  return join(dataDir, WAKEWORD_DIR_REL)
}

export function isWakewordCoreInstalled(): boolean {
  return (
    WAKEWORD_SHARED.every((f) => existsSync(join(dataDir, WAKEWORD_DIR_REL, f))) &&
    existsSync(join(dataDir, WAKEWORD_DIR_REL, WAKEWORD_DEFAULT_DETECTOR))
  )
}

export async function downloadWakewordCore(
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  for (const f of [...WAKEWORD_SHARED, WAKEWORD_DEFAULT_DETECTOR]) {
    await downloadUrl(`${OWW_BASE}/${f}`, `${WAKEWORD_DIR_REL}/${f}`, onProgress, signal)
  }
}

// ── Silero VAD model ──────────────────────────────────────────────────────────
// Small neural voice-activity detector (v5). Used by the backend STT session for
// utterance endpointing and served to the browser (/api/voice/vad-model) for the
// barge-in speech gate. Lives in data/voice/ — NOT wakewords/ — because the
// /api/voice/wakewords discovery route would otherwise list it as a detector.
const SILERO_VAD_URL =
  'https://raw.githubusercontent.com/snakers4/silero-vad/v5.1.2/src/silero_vad/data/silero_vad.onnx'
const SILERO_VAD_SHA256 = '2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f'
export const SILERO_VAD_REL = 'voice/silero_vad.onnx'

export function sileroVadPath(): string {
  return join(dataDir, SILERO_VAD_REL)
}

export function isSileroVadInstalled(): boolean {
  return existsSync(sileroVadPath())
}

export async function downloadSileroVad(
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  await downloadUrl(SILERO_VAD_URL, SILERO_VAD_REL, onProgress, signal, {
    expectedSha256: SILERO_VAD_SHA256,
    minBytes: 1_500_000,
  })
}

// ── Wakeword negative feature bank ────────────────────────────────────────────
// openWakeWord's precomputed negative features (~11h of diverse real-world
// audio as (N,16,96) embedding windows — the SAME format our trainer produces).
// Training custom positives against this large, real negative set is what makes
// the model reject similar phrases ("hey alexa") and real-mic noise. 180 MB,
// one-time. (The full 2000h bank is 17 GB; this hand-picked subset suffices.)
const NEG_FEATURES_URL = 'https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/validation_set_features.npy'
const NEG_FEATURES_REL = `${WAKEWORD_DIR_REL}/negative_features.npy`

export function negFeaturesPath(): string {
  return join(dataDir, NEG_FEATURES_REL)
}

export function isNegFeaturesInstalled(): boolean {
  return existsSync(negFeaturesPath())
}

export async function downloadNegFeatures(
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  await downloadUrl(NEG_FEATURES_URL, NEG_FEATURES_REL, onProgress, signal)
}

// ── Wakeword real room-impulse-response pack ──────────────────────────────────
// The MIT Environmental Impulse Response survey (resampled to 16 kHz by
// davidscripka, the openWakeWord author; permissively shared for this exact use).
// ~270 real recorded room impulses, ~5 MB total. Convolving synthetic TTS
// positives with REAL room acoustics generalizes far better to a real reverberant
// mic than the procedural exponential-decay RIR the trainer falls back to — this
// is what openWakeWord and microWakeWord both do. Bundled with the Wake Word
// Training install (see installWakewordTrainDeps) so nothing is fetched at train
// time; if absent, train_wakeword.py silently uses procedural reverb instead.
const RIR_TREE_API = 'https://huggingface.co/api/datasets/davidscripka/MIT_environmental_impulse_responses/tree/main/16khz'
const RIR_RESOLVE_BASE = 'https://huggingface.co/datasets/davidscripka/MIT_environmental_impulse_responses/resolve/main'
export const WAKEWORD_RIR_DIR_REL = `${WAKEWORD_DIR_REL}/rir`

export function wakewordRirDir(): string {
  return join(dataDir, WAKEWORD_RIR_DIR_REL)
}

export function isWakewordRirInstalled(): boolean {
  // "Installed" once a marker is present — we drop a sentinel after a full fetch so
  // a partial run (some WAVs, interrupted) re-downloads on the next repair.
  return existsSync(join(wakewordRirDir(), '.complete'))
}

export async function downloadWakewordRirPack(
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (isWakewordRirInstalled()) return
  onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: 0, status: 'Listing room impulse responses…' })
  const res = await fetch(RIR_TREE_API, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`RIR listing failed (${res.status})`)
  const tree = (await res.json()) as { type: string; path: string }[]
  const wavs = tree.filter((t) => t.type === 'file' && t.path.endsWith('.wav'))
  if (wavs.length === 0) throw new Error('RIR listing returned no .wav files')
  for (let i = 0; i < wavs.length; i++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
    const { path } = wavs[i]!
    const name = basename(path)
    await downloadUrl(
      `${RIR_RESOLVE_BASE}/${path}`,
      `${WAKEWORD_RIR_DIR_REL}/${name}`,
      (p) => onProgress({ ...p, status: `Room impulse responses ${i + 1}/${wavs.length}…` }),
      signal,
    )
  }
  await writeFile(join(wakewordRirDir(), '.complete'), String(wavs.length))
}

// ── Wakeword real-noise pack (training + calibration) ─────────────────────────
// MS-SNSD (Microsoft Scalable Noisy Speech Dataset), MIT-licensed real-world
// recordings. The synthetic Kokoro-speech + procedural-noise bank used for
// training and FA eval understates real false-accept risk — the actual FP
// source is a room: TV, family conversation, kitchen/living-room noise. Split
// into disjoint TRAIN and CALIB file sets (different recordings, same
// categories) so the model actually learns to reject real ambient audio
// (mixed into training negatives) while threshold calibration and the eval
// harness measure against real audio the model never trained on — training on
// and evaluating against the same files would silently inflate every number.
// ~26 files, ~90 MB, one-time.
const NOISE_PACK_BASE = 'https://raw.githubusercontent.com/microsoft/MS-SNSD/master/noise_train'
const NOISE_PACK_TRAIN_FILES = [
  'Babble_1.wav', 'Babble_2.wav', 'Babble_3.wav',
  'NeighborSpeaking_1.wav', 'NeighborSpeaking_2.wav', 'NeighborSpeaking_3.wav',
  'AirportAnnouncements_1.wav', 'AirportAnnouncements_2.wav',
  'LivingRoom_1.wav', 'Kitchen_1.wav', 'Restaurant_1.wav', 'Office_1.wav', 'Traffic_1.wav',
]
const NOISE_PACK_CALIB_FILES = [
  'Babble_4.wav', 'Babble_5.wav', 'Babble_6.wav',
  'NeighborSpeaking_4.wav', 'NeighborSpeaking_5.wav', 'NeighborSpeaking_6.wav',
  'AirportAnnouncements_3.wav', 'AirportAnnouncements_4.wav',
  'Cafe_1.wav', 'CafeTeria_1.wav', 'Park_1.wav', 'Square_1.wav', 'Hallway_1.wav',
]
export const WAKEWORD_NOISE_DIR_REL = `${WAKEWORD_DIR_REL}/noise`
const WAKEWORD_NOISE_TRAIN_REL = `${WAKEWORD_NOISE_DIR_REL}/train`
const WAKEWORD_NOISE_CALIB_REL = `${WAKEWORD_NOISE_DIR_REL}/calib`

export function wakewordNoiseTrainDir(): string {
  return join(dataDir, WAKEWORD_NOISE_TRAIN_REL)
}

export function wakewordNoiseCalibDir(): string {
  return join(dataDir, WAKEWORD_NOISE_CALIB_REL)
}

export function isWakewordNoisePackInstalled(): boolean {
  return existsSync(join(wakewordNoiseTrainDir(), '.complete')) && existsSync(join(wakewordNoiseCalibDir(), '.complete'))
}

export async function downloadWakewordNoisePack(
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (isWakewordNoisePackInstalled()) return
  const all = [
    ...NOISE_PACK_TRAIN_FILES.map((name) => ({ name, rel: WAKEWORD_NOISE_TRAIN_REL })),
    ...NOISE_PACK_CALIB_FILES.map((name) => ({ name, rel: WAKEWORD_NOISE_CALIB_REL })),
  ]
  for (let i = 0; i < all.length; i++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
    const { name, rel } = all[i]!
    await downloadUrl(
      `${NOISE_PACK_BASE}/${name}`,
      `${rel}/${name}`,
      (p) => onProgress({ ...p, status: `Real noise samples ${i + 1}/${all.length}…` }),
      signal,
    )
  }
  // MIT license asks the copyright notice be preserved — no user-facing attribution
  // needed, so a NOTICE file alongside the audio satisfies it.
  const notice = 'Audio from MS-SNSD (MIT License)\nhttps://github.com/microsoft/MS-SNSD\n'
  await writeFile(join(wakewordNoiseTrainDir(), 'NOTICE'), notice)
  await writeFile(join(wakewordNoiseCalibDir(), 'NOTICE'), notice)
  await writeFile(join(wakewordNoiseTrainDir(), '.complete'), String(NOISE_PACK_TRAIN_FILES.length))
  await writeFile(join(wakewordNoiseCalibDir(), '.complete'), String(NOISE_PACK_CALIB_FILES.length))
}

let noisePackPromise: Promise<string> | null = null
/** Resolve the noise pack base dir, downloading it on first use (mirrors ensureStingerSoundfont).
 *  Best-effort: callers should tolerate rejection and fall back to synthetic-only audio. */
export async function ensureWakewordNoisePack(): Promise<string> {
  if (isWakewordNoisePackInstalled()) return wakewordNoiseTrainDir()
  if (!noisePackPromise) {
    noisePackPromise = (async () => {
      await downloadWakewordNoisePack(() => {})
      try { const { recordInstalled } = await import('@/lib/installRegistry'); await recordInstalled('wakeword-train-noise') }
      catch { /* ledger is best-effort */ }
      return wakewordNoiseTrainDir()
    })().catch((e) => { noisePackPromise = null; throw e })
  }
  return noisePackPromise
}

// ── Wakeword training venv ────────────────────────────────────────────────────
// Lightweight Python venv used only by train_wakeword.py.
// Kept separate from the ComfyUI venv to avoid dependency conflicts.

const WAKEWORD_TRAIN_VENV_REL = 'voice/wakeword-train-venv'

export function wakewordTrainVenv(): string {
  return join(dataDir, WAKEWORD_TRAIN_VENV_REL)
}

export function wakewordTrainPython(): string {
  const venv = wakewordTrainVenv()
  return process.platform === 'win32'
    ? join(venv, 'Scripts', 'python.exe')
    : join(venv, 'bin', 'python')
}

export function isWakewordTrainInstalled(): boolean {
  return existsSync(wakewordTrainPython())
}

export async function installWakewordTrainDeps(
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const venv   = wakewordTrainVenv()
  const python = wakewordTrainPython()

  if (!existsSync(python)) {
    onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: 0, status: 'Preparing Python…' })
    const { ensurePython } = await import('@/lib/python')
    const py = await ensurePython()
    if (!py) throw new Error('Python 3.10+ is required for wake-word training but could not be found or downloaded. Install Python from https://www.python.org/downloads/ and try again.')
    onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: 0, status: 'Creating Python venv…' })
    await runCmd(py, ['-m', 'venv', venv], dataDir, onProgress, signal)
  }

  const pip = process.platform === 'win32'
    ? join(venv, 'Scripts', 'pip.exe')
    : join(venv, 'bin', 'pip')

  if (!existsSync(pip)) {
    onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: 0, status: 'Bootstrapping pip…' })
    await runCmd(python, ['-m', 'ensurepip', '--upgrade'], dataDir, onProgress, signal)
  }

  onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: 0, status: 'Installing Python packages (onnxruntime, scikit-learn, onnx, scipy)…' })
  await runCmd(pip, ['install', '--quiet', 'onnxruntime', 'numpy', 'scikit-learn', 'onnx', 'scipy'], dataDir, onProgress, signal)

  // Bundle the real room-impulse-response pack with the training feature so the
  // trainer never reaches out to the network itself. Best-effort: a failure here
  // (offline, HF down) must not block training — train_wakeword.py falls back to
  // procedural reverb when the pack is absent.
  try {
    await downloadWakewordRirPack(onProgress, signal)
    // Record it so boot reconcile protects/heals it on future boots (dynamic import
    // avoids a static cycle — installRegistry imports this module).
    try { const { recordInstalled } = await import('@/lib/installRegistry'); await recordInstalled('wakeword-train-rir') }
    catch { /* ledger is best-effort */ }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: 0, status: `Room-impulse pack skipped (${err instanceof Error ? err.message.split('\n')[0] : String(err)}) — procedural reverb will be used` })
  }

  // Real-noise calibration pack, same best-effort treatment — absence just means
  // threshold calibration falls back to the synthetic held-out negatives.
  try {
    await downloadWakewordNoisePack(onProgress, signal)
    try { const { recordInstalled } = await import('@/lib/installRegistry'); await recordInstalled('wakeword-train-noise') }
    catch { /* ledger is best-effort */ }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: 0, status: `Real-noise pack skipped (${err instanceof Error ? err.message.split('\n')[0] : String(err)}) — synthetic-only calibration will be used` })
  }
}

/** Download a single detector model file (used by the wakeword browser). */
export async function downloadWakewordModel(
  fileName: string,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  await downloadUrl(`${OWW_BASE}/${fileName}`, `${WAKEWORD_DIR_REL}/${fileName}`, onProgress, signal)
}

export const OPENWAKEWORD_BASE = OWW_BASE

// ── ComfyUI setup ─────────────────────────────────────────────────────────────

const COMFYUI_REPO      = 'https://github.com/comfyanonymous/ComfyUI.git'
const COMFYUI_DIR_REL   = 'comfyui'
const COMFYUI_VENV_REL  = 'comfyui-venv'

const COMFYUI_CUSTOM_NODES: { label: string; url: string }[] = [
  { label: 'IPAdapter Plus',       url: 'https://github.com/cubiq/ComfyUI_IPAdapter_plus.git' },
  { label: 'ControlNet Aux',       url: 'https://github.com/Fannovel16/comfyui_controlnet_aux.git' },
  { label: 'AnimateDiff Evolved',  url: 'https://github.com/Kosinkadink/ComfyUI-AnimateDiff-Evolved.git' },
  { label: 'Impact Pack',          url: 'https://github.com/ltdrdata/ComfyUI-Impact-Pack.git' },
  { label: 'UltimateSDUpscale',    url: 'https://github.com/ssitu/ComfyUI_UltimateSDUpscale.git' },
]

// Background removal/blur runs the BiRefNet-lite ONNX model. We ship our own
// self-contained ComfyUI node rather than depending on an external repo:
//
//   - The ZHO repo (ComfyUI-BiRefNet-ZHO) used bare absolute imports
//     (`from utils import …`, `from models.baseline import …`) that collide with
//     ComfyUI's own top-level `utils`/`models` packages — it fails to import on
//     every boot, so restarting never fixed it.
//   - That repo also only exposed PyTorch (.pth) loader nodes, never a node named
//     `BiRefNet` taking an ONNX file — which is what our workflows submit.
//
// This node registers exactly `BiRefNet` (image, model, device → RGBA cutout +
// subject mask) and runs the ONNX via onnxruntime, with only relative imports.
const STALE_ZHO_NODE_DIR   = 'comfyui/custom_nodes/ComfyUI-BiRefNet-ZHO'
const BIREFNET_NODE_DIR    = 'comfyui/custom_nodes/loki_birefnet'
const FACERESTORE_NODE_DIR = 'comfyui/custom_nodes/facerestore_cf'
const FACERESTORE_NODE_URL = 'https://github.com/mav-rik/facerestore_cf.git'

const BIREFNET_NODE_SOURCE = String.raw`# Auto-generated by loki-doki — self-contained BiRefNet (ONNX) ComfyUI node.
# Do not edit by hand; it is rewritten on Extensions repair.
import os
import numpy as np
import torch
import folder_paths

# Register the models/onnx folder so the model dropdown can enumerate .onnx files.
_ONNX_DIR = os.path.join(folder_paths.models_dir, "onnx")
os.makedirs(_ONNX_DIR, exist_ok=True)
folder_paths.folder_names_and_paths["onnx"] = ([_ONNX_DIR], {".onnx"})

# BiRefNet expects ImageNet-normalized RGB at 1024x1024.
_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32).reshape(1, 3, 1, 1)
_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32).reshape(1, 3, 1, 1)

_SESSIONS = {}


def _get_session(model_name, device):
    import onnxruntime as ort
    path = folder_paths.get_full_path("onnx", model_name) or os.path.join(_ONNX_DIR, model_name)
    if not os.path.exists(path):
        raise FileNotFoundError("BiRefNet ONNX model not found: %s" % model_name)
    key = (path, device)
    sess = _SESSIONS.get(key)
    if sess is None:
        providers = ["CPUExecutionProvider"]
        if device == "cuda" and "CUDAExecutionProvider" in ort.get_available_providers():
            providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        sess = ort.InferenceSession(path, providers=providers)
        _SESSIONS[key] = sess
    return sess


class BiRefNet:
    @classmethod
    def INPUT_TYPES(cls):
        try:
            files = folder_paths.get_filename_list("onnx")
        except Exception:
            files = []
        if not files:
            files = ["BiRefNet-lite.onnx"]
        return {
            "required": {
                "image": ("IMAGE",),
                "model": (files,),
                "device": (["cpu", "cuda"],),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "process"
    CATEGORY = "image/background"

    def process(self, image, model, device):
        sess = _get_session(model, device)
        in_name = sess.get_inputs()[0].name
        out_name = sess.get_outputs()[0].name

        out_images = []
        out_masks = []
        for img in image:  # img: [H, W, C] float 0..1
            h, w = int(img.shape[0]), int(img.shape[1])
            rgb = img[:, :, :3].detach().cpu().float()  # [H, W, 3]

            t = rgb.permute(2, 0, 1).unsqueeze(0)  # [1, 3, H, W]
            t = torch.nn.functional.interpolate(t, size=(1024, 1024), mode="bilinear", align_corners=False)
            x = (t.numpy().astype(np.float32) - _MEAN) / _STD

            logits = sess.run([out_name], {in_name: x.astype(np.float32)})[0]  # [1, 1, 1024, 1024]
            mask = 1.0 / (1.0 + np.exp(-logits))  # sigmoid -> foreground probability

            mask_t = torch.from_numpy(mask.astype(np.float32))  # [1, 1, 1024, 1024]
            mask_t = torch.nn.functional.interpolate(mask_t, size=(h, w), mode="bilinear", align_corners=False)
            mask_2d = mask_t[0, 0].clamp(0.0, 1.0)  # [H, W]

            rgba = torch.cat([rgb, mask_2d.unsqueeze(-1)], dim=-1)  # [H, W, 4]
            out_images.append(rgba.unsqueeze(0))
            out_masks.append(mask_2d.unsqueeze(0))

        return (torch.cat(out_images, dim=0), torch.cat(out_masks, dim=0))


NODE_CLASS_MAPPINGS = {"BiRefNet": BiRefNet}
NODE_DISPLAY_NAME_MAPPINGS = {"BiRefNet": "BiRefNet (ONNX)"}
`

export function isBiRefNetNodeInstalled(): boolean {
  return existsSync(join(dataDir, BIREFNET_NODE_DIR, '__init__.py'))
}

// Write our self-contained BiRefNet ONNX node into custom_nodes and make sure
// onnxruntime is available in the venv. Also removes the broken ZHO repo if a
// previous install left it behind. Idempotent.
export async function installBiRefNetNode(
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  // Drop the broken upstream node if present — it never imported and shadows nothing.
  const staleDir = join(dataDir, STALE_ZHO_NODE_DIR)
  if (existsSync(staleDir)) {
    onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: 0, status: 'Removing broken BiRefNet node…' })
    await rm(staleDir, { recursive: true, force: true })
  }

  const nodeDir = join(dataDir, BIREFNET_NODE_DIR)
  onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: 0, status: 'Installing BiRefNet node…' })
  await mkdir(nodeDir, { recursive: true })
  await writeFile(join(nodeDir, '__init__.py'), BIREFNET_NODE_SOURCE)

  // onnxruntime is required to run the model and is not part of ComfyUI's base deps.
  onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: 0, status: 'Installing BiRefNet dependencies…' })
  await runCmd(venvPip(), ['install', 'onnxruntime'], nodeDir, onProgress, signal)
}

export function isFaceRestoreNodeInstalled(): boolean {
  return existsSync(join(dataDir, FACERESTORE_NODE_DIR))
}

export async function installFaceRestoreNode(
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const nodesDir = join(dataDir, COMFYUI_DIR_REL, 'custom_nodes')
  await mkdir(nodesDir, { recursive: true })

  const nodeDir = join(dataDir, FACERESTORE_NODE_DIR)
  if (!existsSync(nodeDir)) {
    onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: 0, status: 'Installing FaceRestore node…' })
    await runCmd('git', ['clone', '--depth', '1', FACERESTORE_NODE_URL], nodesDir, onProgress, signal)
  }

  const reqFile = join(nodeDir, 'requirements.txt')
  if (existsSync(reqFile)) {
    onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: 0, status: 'Installing FaceRestore node dependencies…' })
    await runCmd(venvPip(), ['install', '-r', reqFile], nodeDir, onProgress, signal)
  }
}

function venvPip(): string {
  const venvDir = join(dataDir, COMFYUI_VENV_REL)
  return process.platform === 'win32'
    ? join(venvDir, 'Scripts', 'pip.exe')
    : join(venvDir, 'bin', 'pip')
}

// Runs a command, emitting the last stdout/stderr line as status on each tick.
// On non-zero exit, includes the last ~2KB of output in the error message.
async function runCmd(
  cmd: string,
  args: string[],
  cwd: string,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
  env?: Record<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })

    if (signal) {
      const abort = () => { child.kill(); reject(new DOMException('Cancelled', 'AbortError')) }
      signal.addEventListener('abort', abort, { once: true })
      child.on('close', () => signal.removeEventListener('abort', abort))
    }

    // A failed spawn (e.g. ENOENT, binary not on PATH) fires 'error' but never 'close',
    // so without this the Promise would hang forever instead of surfacing the failure.
    child.on('error', (err) => reject(err))

    const tail: string[] = []
    const onData = (d: Buffer) => {
      const text = d.toString()
      const lines = text.trim().split('\n').filter(Boolean)
      for (const l of lines) {
        tail.push(l)
        if (tail.length > 50) tail.shift()
        onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: 0, status: l.slice(0, 120) })
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    child.on('close', (code) => {
      if (code === 0) { resolve(); return }
      const detail = tail.slice(-10).join('\n')
      reject(new Error(`${cmd} ${args[0]} exited with code ${code}\n${detail}`))
    })
  })
}

export async function setupComfyUIBase(
  config: ComfyUILaunchConfig,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const comfyDir = join(dataDir, COMFYUI_DIR_REL)
  const venvDir  = join(dataDir, COMFYUI_VENV_REL)
  const pip      = venvPip()

  // 1. Create Python venv if missing or if it was built with Python <3.10
  // (av>=16.0.0 in ComfyUI requirements requires Python 3.10+)
  const venvPythonBin = process.platform === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python')
  if (existsSync(venvDir) && existsSync(venvPythonBin)) {
    try {
      const ver = execSync(
        `"${venvPythonBin}" -c "import sys; print(sys.version_info.minor)"`,
        { encoding: 'utf8', timeout: 5_000 },
      ).trim()
      if (parseInt(ver, 10) < 10) {
        onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: 0, status: 'Upgrading Python environment to 3.10+…' })
        await rm(venvDir, { recursive: true, force: true })
      }
    } catch { /* leave it if we can't check */ }
  }

  await mkdir(dataDir, { recursive: true })

  if (!existsSync(venvDir)) {
    // Resolve a Python ≥3.10 — reuse a system one, else auto-download a relocatable build.
    // Dynamic import avoids a module-init cycle (python.ts imports dataDir from here).
    onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: 0, status: 'Preparing Python…' })
    const { ensurePython } = await import('@/lib/python')
    const py = await ensurePython()
    if (!py) {
      throw new Error('Python 3.10+ is required for image generation but could not be found or downloaded. Install Python from https://www.python.org/downloads/ and try again.')
    }
    onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: 0, status: 'Creating Python environment…' })
    await runCmd(py, ['-m', 'venv', venvDir], dataDir, onProgress, signal)
  }

  // macOS system Python (Apple's /usr/bin/python3) creates venvs without pip.
  // Bootstrap it via ensurepip so subsequent pip install calls don't ENOENT.
  if (!existsSync(pip)) {
    onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: 0, status: 'Bootstrapping pip…' })
    const venvPy = process.platform === 'win32'
      ? join(venvDir, 'Scripts', 'python.exe')
      : join(venvDir, 'bin', 'python')
    await runCmd(venvPy, ['-m', 'ensurepip', '--upgrade'], dataDir, onProgress, signal)
  }

  // 2. Clone ComfyUI repo if missing
  if (!existsSync(join(comfyDir, 'main.py'))) {
    onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: 0, status: 'Cloning ComfyUI…' })
    await runCmd('git', ['clone', '--depth', '1', COMFYUI_REPO, comfyDir], dataDir, onProgress, signal)
  }

  // 3. Install PyTorch (platform-specific)
  onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: 0, status: 'Installing PyTorch (this may take a few minutes)…' })
  const torchArgs = config.dtype === 'fp8'
    // CUDA path
    ? [pip, 'install', 'torch', 'torchvision', 'torchaudio', '--index-url', 'https://download.pytorch.org/whl/cu124']
    // MPS / CPU path — pip install with no extra index; MPS is auto-detected on Apple Silicon
    : [pip, 'install', 'torch', 'torchvision', 'torchaudio']
  await runCmd(torchArgs[0], torchArgs.slice(1), dataDir, onProgress, signal)

  // 4. Install xformers (CUDA only — speeds up attention + saves VRAM)
  if (config.dtype === 'fp8') {
    onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: 0, status: 'Installing xFormers…' })
    await runCmd(pip, ['install', 'xformers', '--index-url', 'https://download.pytorch.org/whl/cu124'], dataDir, onProgress, signal)
  }

  // 5. Install ComfyUI requirements
  onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: 0, status: 'Installing ComfyUI dependencies…' })
  await runCmd(pip, ['install', '-r', join(comfyDir, 'requirements.txt')], dataDir, onProgress, signal)
}

export async function installComfyUINodes(
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const nodesDir = join(dataDir, COMFYUI_DIR_REL, 'custom_nodes')
  const pip      = venvPip()
  await mkdir(nodesDir, { recursive: true })

  for (const node of COMFYUI_CUSTOM_NODES) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')

    const dirName = node.url.split('/').pop()?.replace(/\.git$/, '') ?? ''
    const nodeDir = join(nodesDir, dirName)

    if (!existsSync(nodeDir)) {
      onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: 0, status: `Installing ${node.label}…` })
      await runCmd('git', ['clone', '--depth', '1', node.url], nodesDir, onProgress, signal)
    }

    // Install node-specific requirements if present.
    // Non-fatal: ComfyUI skips nodes that fail to import, so a bad package
    // shouldn't block the nodes that install cleanly.
    const reqFile = join(nodeDir, 'requirements.txt')
    if (existsSync(reqFile)) {
      onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: 0, status: `Installing ${node.label} dependencies…` })
      try {
        await runCmd(pip, ['install', '-r', reqFile], nodeDir, onProgress, signal)
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') throw err
        onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: 0, status: `Warning: ${node.label} deps failed (node may still load) — ${err instanceof Error ? err.message.split('\n')[0] : err}` })
      }
    }
  }

  // BiRefNet is shipped by us, not cloned — install it as part of the node set.
  await installBiRefNetNode(onProgress, signal)
}

// ── Face restore models ───────────────────────────────────────────────────────

const CODEFORMER_URL  = 'https://github.com/sczhou/CodeFormer/releases/download/v0.1.0/codeformer.pth'
const CODEFORMER_DEST = 'comfyui/models/facerestore_models/codeformer.pth'

const GFPGAN_URL  = 'https://github.com/TencentARC/GFPGAN/releases/download/v1.3.4/GFPGANv1.4.pth'
const GFPGAN_DEST = 'comfyui/models/facerestore_models/GFPGANv1.4.pth'

export function isCodeFormerInstalled(): boolean {
  return existsSync(join(dataDir, CODEFORMER_DEST))
}

export async function downloadCodeFormerModel(
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  await downloadUrl(CODEFORMER_URL, CODEFORMER_DEST, onProgress, signal)
}

export function isGFPGANInstalled(): boolean {
  return existsSync(join(dataDir, GFPGAN_DEST))
}

export async function downloadGFPGANModel(
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  await downloadUrl(GFPGAN_URL, GFPGAN_DEST, onProgress, signal)
}

// ── Weather icons ──────────────────────────────────────────────────────────────

const WEATHER_ICONS_URL = 'https://www.amcharts.com/dl/svg-weather-icons/'
const WEATHER_ICONS_ZIP = 'downloads/weather-icons.zip'

function weatherIconsTargetDir(): string {
  const distDir = resolve(process.cwd(), '../frontend/dist')
  return existsSync(join(distDir, 'index.html'))
    ? join(distDir, 'weather-icons')
    : resolve(process.cwd(), '../frontend/public/weather-icons')
}

export function isWeatherIconsInstalled(): boolean {
  return existsSync(join(weatherIconsTargetDir(), 'animated', 'day.svg'))
}

export async function downloadWeatherIcons(
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  await downloadUrl(WEATHER_ICONS_URL, WEATHER_ICONS_ZIP, onProgress, signal)
  const zipPath = join(dataDir, WEATHER_ICONS_ZIP)
  const dest = weatherIconsTargetDir()
  await mkdir(dest, { recursive: true })
  extractZip(zipPath, dest, 30_000)
}

// Downloads a ComfyUI model file from the catalog entry.
// Handles both HuggingFace (hf) and direct URL (url) sources.
export async function downloadComfyUIModel(
  model: CatalogModel,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (model.url) {
    await downloadLargeUrl(model.url.downloadUrl, model.url.dest, model.approxBytes, onProgress, signal)
  } else if (model.hf) {
    await downloadHfFile(model.hf, onProgress, signal, model.approxBytes)
  } else if (model.hfFiles) {
    let accumulated = 0
    for (const hfFile of model.hfFiles) {
      const fileBytes = hfFile.approxBytes ?? 0
      await downloadHfFile(
        hfFile,
        (p) => onProgress({ ...p, completed: accumulated + p.completed, total: model.approxBytes }),
        signal,
      )
      accumulated += fileBytes
    }
  } else {
    throw new Error(`Catalog entry ${model.id} has no download source`)
  }
}
