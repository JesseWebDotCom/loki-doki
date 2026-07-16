// Managed Claude Code CLI install: the agentic coding tool behind the Coding app and
// the companion coding tool (replaces OpenCode — see codingServer.ts). Installed as a
// pinned npm dependency (`@anthropic-ai/claude-code`) into its own managed directory,
// same pattern as opencode.ts: `bun add` resolves the correct platform binary itself,
// no OS/arch URL table to maintain here.

import { join } from 'node:path'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dataDir } from '@/lib/download'
import { ensureNode } from '@/lib/node'
import { IS_WIN } from '@/lib/platform'
import { logger } from '@/lib/logger'

// Pinned version, bump deliberately, not on every install.
const CLAUDE_CODE_VERSION = '2.1.200'

export const CLAUDE_CODE_DIR = join(dataDir, 'coding', 'claude-runtime')
const BIN_DIR = join(CLAUDE_CODE_DIR, 'node_modules', '.bin')
export const CLAUDE_BIN = join(BIN_DIR, IS_WIN ? 'claude.exe' : 'claude')
// The `.bin/claude` shim only remaps to the REAL native binary, which the package's postinstall
// (install.cjs) provisions from a platform optionalDependency into node_modules/.../bin. That
// binary is what actually runs, so it's the meaningful "is it installed" signal.
const CLAUDE_PKG_BIN = join(CLAUDE_CODE_DIR, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', IS_WIN ? 'claude.exe' : 'claude')

export function isClaudeCodeInstalled(): boolean {
  // Require BOTH the launcher shim AND the real native binary it points at. Checking the shim
  // alone reports "installed" while the CLI fails at runtime with "bin executable does not exist
  // on disk" — exactly what happens when Bun skips the postinstall that provisions the binary.
  return existsSync(CLAUDE_BIN) && existsSync(CLAUDE_PKG_BIN)
}

export async function installClaudeCode(onStatus: (msg: string) => void, signal?: AbortSignal): Promise<void> {
  mkdirSync(CLAUDE_CODE_DIR, { recursive: true })
  // Always (re)write package.json with `trustedDependencies`: the package's real native binary is
  // provisioned by its postinstall (install.cjs copies it from a platform optionalDependency), and
  // Bun SKIPS lifecycle scripts unless the dependency is trusted. Without this the install leaves a
  // .bin shim that can't remap and fails at runtime with "bin executable does not exist on disk".
  const pkgPath = join(CLAUDE_CODE_DIR, 'package.json')
  writeFileSync(pkgPath, JSON.stringify({
    name: 'loki-doki-claude-code-runtime', private: true,
    trustedDependencies: ['@anthropic-ai/claude-code'],
  }, null, 2))
  // Start from a clean tree so bun regenerates the launcher shims and re-runs the postinstall from
  // scratch (a re-run over an existing tree renames the live binary to a stale .old copy each time).
  rmSync(join(CLAUDE_CODE_DIR, 'node_modules'), { recursive: true, force: true })
  rmSync(join(CLAUDE_CODE_DIR, 'bun.lock'), { force: true })
  onStatus(`Installing Claude Code ${CLAUDE_CODE_VERSION}…`)
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('bun', ['add', `@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`], {
      cwd: CLAUDE_CODE_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const onLine = (chunk: Buffer) => {
      const line = chunk.toString().trim()
      if (line) onStatus(line)
    }
    proc.stdout.on('data', onLine)
    proc.stderr.on('data', onLine)
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`bun add @anthropic-ai/claude-code exited ${code}`))))
    proc.on('error', reject)
    signal?.addEventListener('abort', () => { proc.kill(); reject(new DOMException('Cancelled', 'AbortError')) })
  })
  if (!isClaudeCodeInstalled()) throw new Error('@anthropic-ai/claude-code installed but binary not found: install may have failed')
  logger.info(`[claude-code] installed → ${CLAUDE_BIN}`)

  // Provision the Node runtime the coding PTY sidecar runs under (node-pty's data callbacks
  // are unreliable under Bun — see coding-pty-sidecar.ts), so installing the coding package
  // downloads every dependency up front rather than stalling the first /coding open on a Node
  // fetch. Best-effort: the sidecar still resolves/downloads Node lazily if this is skipped.
  onStatus('Preparing coding runtime (Node)…')
  try { await ensureNode() } catch (err) {
    logger.warn(`[claude-code] Node runtime prefetch failed (will resolve on first use): ${err instanceof Error ? err.message : String(err)}`)
  }
  onStatus('Claude Code ready')
}
