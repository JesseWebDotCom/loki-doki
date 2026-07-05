// Cross-platform helpers for the install/boot path. macOS and Linux can lean on
// unix tools (unzip, pkill); Windows has neither, so these route to PowerShell.
//
// Everything here is async on purpose: these run in-process on the single-threaded
// backend, and the old execSync/execFileSync versions froze the event loop (and with
// it /api/health) for the full duration of an extract — minutes for the ~700 MB
// Ollama zip on Windows.

import { exec, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

export const IS_WIN = process.platform === 'win32'
export const IS_MAC = process.platform === 'darwin'
export const IS_LINUX = process.platform === 'linux'

function psEscape(s: string): string {
  // Single-quoted PowerShell strings escape an embedded quote by doubling it.
  return s.replace(/'/g, "''")
}

/**
 * Extract a .zip archive. Uses `unzip` on macOS/Linux and PowerShell's
 * `Expand-Archive` on Windows (which ships with Windows 10+; `unzip` does not).
 * The source must have a real .zip extension or Expand-Archive rejects it.
 */
export async function extractZip(zipPath: string, destDir: string, timeoutMs = 120_000): Promise<void> {
  if (IS_WIN) {
    const cmd = `Expand-Archive -LiteralPath '${psEscape(zipPath)}' -DestinationPath '${psEscape(destDir)}' -Force`
    await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: timeoutMs })
  } else {
    await execAsync(`unzip -o "${zipPath}" -d "${destDir}"`, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
  }
}

/**
 * Extract any archive we download (.zip / .tar.gz / .tar.xz) by extension.
 * tar ships on macOS, Linux, and Windows 10+ (bsdtar) and auto-detects compression.
 */
export async function extractArchive(archivePath: string, destDir: string, timeoutMs = 180_000): Promise<void> {
  await mkdir(destDir, { recursive: true })
  if (archivePath.endsWith('.zip')) {
    await extractZip(archivePath, destDir, timeoutMs)
  } else {
    await execFileAsync('tar', ['-xf', archivePath, '-C', destDir], { timeout: timeoutMs })
  }
}

/**
 * Depth-first search for a file by exact name under `dir`. Archives nest binaries
 * under versioned folders (`ffmpeg-<ver>/bin/ffmpeg`, `node-<ver>/bin/node`, …) —
 * this finds them without hardcoding each layout. (A literal glob here — star then
 * slash — would terminate this comment block and break the parse.)
 */
export async function findFileInTree(dir: string, name: string): Promise<string | null> {
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()!
    let entries
    try { entries = await readdir(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.name === name) return p
    }
  }
  return null
}

/**
 * Best-effort kill of any process whose full command line contains `pattern`.
 * Used to clear orphaned subprocesses (map builds, a stale Ollama binary) left by
 * a previous run. Never throws — a miss just means nothing matched.
 */
export async function killByCommandLine(pattern: string): Promise<void> {
  try {
    if (IS_WIN) {
      const cmd = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${psEscape(pattern)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
      await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 5_000 })
    } else {
      await execAsync(`pkill -f '${pattern}' 2>/dev/null`, { timeout: 5_000 })
    }
  } catch { /* none running — best-effort */ }
}
