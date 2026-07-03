// Managed OpenCode CLI install: the agentic coding tool behind the Coding app and
// the companion coding tool. Installed as a pinned npm dependency (`opencode-ai`)
// into its own managed directory rather than a hand-rolled per-platform GitHub
// release download: the package ships platform-specific binaries via
// optionalDependencies (same pattern as esbuild/swc), so `bun add` already resolves
// the correct native binary for the host, no OS/arch URL table to maintain here.

import { join } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dataDir } from '@/lib/download'
import { IS_WIN } from '@/lib/platform'
import { logger } from '@/lib/logger'

// Pinned versions, bump deliberately, not on every install.
const OPENCODE_VERSION = '1.17.13'
// opencode.json's Ollama provider config (see codingServer.ts's writeConfig) declares
// `npm: '@ai-sdk/openai-compatible'` for the adapter package OpenCode should dynamically
// load, but `bun add opencode-ai` alone never installs it, since it's not a listed
// dependency, just an npm specifier OpenCode's OWN config loader resolves at runtime.
// Confirmed live: without it actually present in node_modules, OpenCode doesn't error
// loudly, it just silently drops the whole ollama provider and falls back to its own
// built-in free-tier models, no Ornith option anywhere in the picker.
const OPENAI_COMPAT_VERSION = '3.0.5'

export const OPENCODE_DIR = join(dataDir, 'coding', 'runtime')
const BIN_DIR = join(OPENCODE_DIR, 'node_modules', '.bin')
export const OPENCODE_BIN = join(BIN_DIR, IS_WIN ? 'opencode.exe' : 'opencode')

export function isOpenCodeInstalled(): boolean {
  return existsSync(OPENCODE_BIN)
}

export async function installOpenCode(onStatus: (msg: string) => void, signal?: AbortSignal): Promise<void> {
  mkdirSync(OPENCODE_DIR, { recursive: true })
  const pkgPath = join(OPENCODE_DIR, 'package.json')
  if (!existsSync(pkgPath)) {
    writeFileSync(pkgPath, JSON.stringify({ name: 'loki-doki-coding-runtime', private: true }, null, 2))
  }
  onStatus(`Installing OpenCode ${OPENCODE_VERSION}…`)
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('bun', ['add', `opencode-ai@${OPENCODE_VERSION}`, `@ai-sdk/openai-compatible@${OPENAI_COMPAT_VERSION}`], {
      cwd: OPENCODE_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const onLine = (chunk: Buffer) => {
      const line = chunk.toString().trim()
      if (line) onStatus(line)
    }
    proc.stdout.on('data', onLine)
    proc.stderr.on('data', onLine)
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`bun add opencode-ai exited ${code}`))))
    proc.on('error', reject)
    signal?.addEventListener('abort', () => { proc.kill(); reject(new DOMException('Cancelled', 'AbortError')) })
  })
  if (!isOpenCodeInstalled()) throw new Error('opencode-ai installed but binary not found: install may have failed')
  logger.info(`[opencode] installed → ${OPENCODE_BIN}`)
  onStatus('OpenCode ready')
}
