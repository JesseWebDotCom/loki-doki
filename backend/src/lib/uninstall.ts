// Full-uninstall engine — single source of truth for tearing the install down to
// nothing. Removes every byte this app put on disk: the data directory (database,
// downloaded models, ComfyUI + Python venvs, maps, ZIMs, voice, images, loras,
// caches, logs), every Ollama model it pulled, AND the system-wide Ollama install.
//
// Two entry points:
//   collectUninstallTargets() — read-only preview for the confirmation dialog.
//   runUninstall(emit)        — performs the wipe, streaming step/progress events.
//
// The caller (adminUninstall route) shuts the server process down after this
// resolves so nothing keeps the deleted database open or rewrites it.

import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { exec, execSync } from 'node:child_process'
import { promisify } from 'node:util'
import { dataDir } from '@/lib/download'
import { COMFYUI_PORT } from '@/lib/comfyui'
import { VOICE_PORT } from '@/lib/voiceServer'
import { KIWIX_PORT } from '@/lib/kiwix'

const execAsync = promisify(exec)

function ollamaUrl(): string {
  return (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '')
}

// Streamed progress. `step` mirrors the boot-screen step shape so the frontend can
// render the same status icons; `progress` carries a 0..1 fraction for sub-steps.
export type UninstallStatus = 'running' | 'ok' | 'warn' | 'error'
export interface UninstallEmit {
  (event: 'step', data: { key: string; label: string; status: UninstallStatus; detail?: string }): void | Promise<void>
  (event: 'progress', data: { key: string; completed: number; total: number; label?: string }): void | Promise<void>
}

// ── System Ollama locations ────────────────────────────────────────────────────
// User-installed Ollama drops a binary/app and stores all models under ~/.ollama.

function systemOllamaPaths(): string[] {
  const home = homedir()
  if (process.platform === 'win32') {
    return [
      join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Programs', 'Ollama'),
      join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Ollama'),
      join(home, '.ollama'),
    ]
  }
  // macOS + Linux
  return [
    '/Applications/Ollama.app',
    '/usr/local/bin/ollama',
    '/usr/bin/ollama',
    join(home, '.ollama'),
    join(home, 'Library', 'Application Support', 'Ollama'),
    join(home, 'Library', 'Caches', 'Ollama'),
  ]
}

// ── Preview ─────────────────────────────────────────────────────────────────────

export interface UninstallTargets {
  dataDir: string
  dataEntries: { name: string; sizeBytes: number }[]
  dataTotalBytes: number
  ollamaModels: { name: string; sizeBytes: number }[]
  systemOllamaPaths: { path: string; exists: boolean }[]
}

async function duEntries(dir: string): Promise<{ name: string; sizeBytes: number }[]> {
  if (!existsSync(dir)) return []
  try {
    // One pass: per-top-level-entry size in KB. Hidden files are negligible.
    const { stdout } = await execAsync('du -sk * .[!.]* 2>/dev/null || true', {
      cwd: dir,
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [kb, ...rest] = line.split('\t')
        const name = rest.join('\t') || line.split(/\s+/).slice(1).join(' ')
        return { name, sizeBytes: (parseInt(kb ?? '', 10) || 0) * 1024 }
      })
      .filter((e) => e.name && e.name !== '.' && e.name !== '..')
  } catch {
    // Fall back to a name-only listing (e.g. Windows / no `du`).
    const names = await readdir(dir).catch(() => [] as string[])
    return names.map((name) => ({ name, sizeBytes: 0 }))
  }
}

export async function collectUninstallTargets(): Promise<UninstallTargets> {
  const dataEntries = await duEntries(dataDir)
  const dataTotalBytes = dataEntries.reduce((a, e) => a + e.sizeBytes, 0)

  let ollamaModels: { name: string; sizeBytes: number }[] = []
  try {
    const res = await fetch(`${ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(5_000) })
    if (res.ok) {
      const { models } = (await res.json()) as { models?: { name: string; size?: number }[] }
      ollamaModels = (models ?? []).map((m) => ({ name: m.name, sizeBytes: m.size ?? 0 }))
    }
  } catch { /* Ollama unreachable — nothing to list */ }

  const systemOllama = systemOllamaPaths().map((path) => ({ path, exists: existsSync(path) }))

  return { dataDir, dataEntries, dataTotalBytes, ollamaModels, systemOllamaPaths: systemOllama }
}

// ── Teardown helpers ─────────────────────────────────────────────────────────────

function killByPort(port: number): void {
  if (process.platform === 'win32') return
  try {
    const pids = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null`, { encoding: 'utf8', timeout: 3_000 }).trim()
    for (const pid of pids.split('\n').filter(Boolean)) {
      try { process.kill(parseInt(pid, 10), 'SIGKILL') } catch { /* already dead */ }
    }
  } catch { /* nothing listening */ }
}

function killByName(pattern: string): void {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /IM ${pattern} 2>nul`, { timeout: 5_000 })
    } else {
      // -i = case-insensitive: macOS Ollama runs as ".../MacOS/Ollama" (capital O),
      // which a case-sensitive match on "ollama" would miss.
      execSync(`pkill -9 -if "${pattern}" 2>/dev/null`, { timeout: 5_000 })
    }
  } catch { /* none running */ }
}

async function deleteOllamaModel(name: string): Promise<void> {
  const res = await fetch(`${ollamaUrl()}/api/delete`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`Ollama refused to delete ${name}`)
}

// ── Run ───────────────────────────────────────────────────────────────────────

export async function runUninstall(emit: UninstallEmit): Promise<void> {
  // ── 1. Delete every Ollama model (needs the server alive). ────────────────────
  await emit('step', { key: 'ollama-models', label: 'Removing AI models from Ollama…', status: 'running' })
  let models: { name: string }[] = []
  try {
    const res = await fetch(`${ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(5_000) })
    if (res.ok) models = ((await res.json()) as { models?: { name: string }[] }).models ?? []
  } catch { /* Ollama unreachable */ }

  let modelsRemoved = 0
  for (let i = 0; i < models.length; i++) {
    const m = models[i]!
    await emit('progress', { key: 'ollama-models', completed: i, total: models.length, label: m.name })
    try { await deleteOllamaModel(m.name); modelsRemoved++ } catch { /* keep going; ~/.ollama wipe below is the backstop */ }
  }
  await emit('step', {
    key: 'ollama-models',
    label: models.length ? `Removed ${modelsRemoved}/${models.length} AI models` : 'No AI models to remove',
    status: 'ok',
  })

  // ── 2. Stop every child process so files unlock and nothing respawns. ──────────
  await emit('step', { key: 'processes', label: 'Stopping background services…', status: 'running' })
  killByPort(COMFYUI_PORT)            // ComfyUI image server
  killByPort(VOICE_PORT)              // Kokoro/Whisper voice sidecar
  killByPort(KIWIX_PORT)             // Kiwix/ZIM server
  killByName('zim-server.ts')        // app-spawned ZIM server, macOS/Linux (orphans otherwise)
  killByName('kiwix-serve.exe')      // app-spawned ZIM server, Windows
  killByName('ollama')               // Ollama serve (system + app-spawned, incl. macOS Ollama.app)
  killByName(join(dataDir, 'bin', 'ollama'))
  await new Promise<void>((r) => setTimeout(r, 800)) // let them exit before unlinking
  await emit('step', { key: 'processes', label: 'Background services stopped', status: 'ok' })

  // ── 3. Remove the system-wide Ollama install + its model store (~/.ollama). ────
  await emit('step', { key: 'ollama-system', label: 'Uninstalling Ollama…', status: 'running' })
  const ollamaPaths = systemOllamaPaths().filter(existsSync)
  let ollamaFailed = 0
  for (let i = 0; i < ollamaPaths.length; i++) {
    const p = ollamaPaths[i]!
    await emit('progress', { key: 'ollama-system', completed: i, total: ollamaPaths.length, label: p })
    try { await rm(p, { recursive: true, force: true }) } catch { ollamaFailed++ }
  }
  await emit('step', {
    key: 'ollama-system',
    label: ollamaFailed
      ? `Ollama removed (${ollamaFailed} path(s) need manual deletion)`
      : 'Ollama uninstalled',
    status: ollamaFailed ? 'warn' : 'ok',
    detail: ollamaFailed ? 'Some system paths may require elevated permissions.' : undefined,
  })

  // ── 4. Wipe the data directory contents (keep the empty dir so a reinstall can
  //       recreate the database into it). ───────────────────────────────────────
  await emit('step', { key: 'data', label: 'Deleting app data, models & caches…', status: 'running' })
  let entries: string[] = []
  try { entries = await readdir(dataDir) } catch { /* already gone */ }
  let dataFailed = 0
  for (let i = 0; i < entries.length; i++) {
    const name = entries[i]!
    await emit('progress', { key: 'data', completed: i, total: entries.length, label: name })
    try { await rm(join(dataDir, name), { recursive: true, force: true }) } catch { dataFailed++ }
  }
  await emit('step', {
    key: 'data',
    label: dataFailed ? `App data deleted (${dataFailed} item(s) failed)` : 'App data, models & caches deleted',
    status: dataFailed ? 'warn' : 'ok',
  })
}
