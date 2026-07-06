// Managed Claude Code CLI install: the agentic coding tool behind the Coding app and
// the companion coding tool (replaces OpenCode — see codingServer.ts). Installed as a
// pinned npm dependency (`@anthropic-ai/claude-code`) into its own managed directory,
// same pattern as opencode.ts: `bun add` resolves the correct platform binary itself,
// no OS/arch URL table to maintain here.

import { join } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
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

export function isClaudeCodeInstalled(): boolean {
  return existsSync(CLAUDE_BIN)
}

export async function installClaudeCode(onStatus: (msg: string) => void, signal?: AbortSignal): Promise<void> {
  mkdirSync(CLAUDE_CODE_DIR, { recursive: true })
  const pkgPath = join(CLAUDE_CODE_DIR, 'package.json')
  if (!existsSync(pkgPath)) {
    writeFileSync(pkgPath, JSON.stringify({ name: 'loki-doki-claude-code-runtime', private: true }, null, 2))
  }
  onStatus(`Installing Claude Code ${CLAUDE_CODE_VERSION}…`)
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('bun', ['add', `@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`], {
      cwd: CLAUDE_CODE_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
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
