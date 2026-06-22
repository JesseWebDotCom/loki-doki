// Cross-platform helpers for the install/boot path. macOS and Linux can lean on
// unix tools (unzip, pkill); Windows has neither, so these route to PowerShell.

import { execSync, execFileSync } from 'node:child_process'

export const IS_WIN = process.platform === 'win32'

function psEscape(s: string): string {
  // Single-quoted PowerShell strings escape an embedded quote by doubling it.
  return s.replace(/'/g, "''")
}

/**
 * Extract a .zip archive. Uses `unzip` on macOS/Linux and PowerShell's
 * `Expand-Archive` on Windows (which ships with Windows 10+; `unzip` does not).
 * The source must have a real .zip extension or Expand-Archive rejects it.
 */
export function extractZip(zipPath: string, destDir: string, timeoutMs = 120_000): void {
  if (IS_WIN) {
    const cmd = `Expand-Archive -LiteralPath '${psEscape(zipPath)}' -DestinationPath '${psEscape(destDir)}' -Force`
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: timeoutMs, stdio: 'ignore' })
  } else {
    execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { timeout: timeoutMs })
  }
}

/**
 * Best-effort kill of any process whose full command line contains `pattern`.
 * Used to clear orphaned subprocesses (map builds, a stale Ollama binary) left by
 * a previous run. Never throws — a miss just means nothing matched.
 */
export function killByCommandLine(pattern: string): void {
  try {
    if (IS_WIN) {
      const cmd = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${psEscape(pattern)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
      execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 5_000, stdio: 'ignore' })
    } else {
      execSync(`pkill -f '${pattern}' 2>/dev/null`, { timeout: 5_000, stdio: 'ignore' })
    }
  } catch { /* none running — best-effort */ }
}
