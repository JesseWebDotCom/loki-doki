// git resolver with on-demand bootstrap.
//
// ComfyUI (image gen) and SearXNG (web search) are provisioned by `git clone` + incremental
// `git fetch`. git is the one native prerequisite the app can't assume is present:
//   • fresh Windows has NO git and NO prompt to install one → those features are dead on arrival;
//   • fresh macOS ships a /usr/bin/git shim that pops the Xcode Command Line Tools GUI installer.
// So on Windows we download a portable MinGit under data/bin. On macOS/Linux a standalone,
// prompt-free git isn't practical to fetch, so we prefer PATH git and otherwise surface a clear,
// actionable error (rather than a raw ENOENT) telling the user how to install it once.

import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dataDir, downloadUrl } from '@/lib/download'
import { IS_WIN, extractArchive, findFileInTree } from '@/lib/platform'
import { logger } from '@/lib/logger'

const execFileAsync = promisify(execFile)

const BIN_DIR = join(dataDir, 'bin')
const GIT_HOME = join(BIN_DIR, 'mingit')

// Pinned portable MinGit (Windows only): a self-contained git with no installer. git.exe lives
// at <root>/cmd/git.exe or <root>/mingw64/bin/git.exe depending on the build.
const MINGIT_URL = 'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/MinGit-2.47.1-64-bit.zip'

let resolvedGit = 'git'
let resolvePromise: Promise<string> | null = null

export function gitBin(): string { return resolvedGit }

async function works(bin: string): Promise<boolean> {
  try { await execFileAsync(bin, ['--version'], { timeout: 10_000, windowsHide: true }); return true } catch { return false }
}

async function downloadManagedWindows(onStatus?: (msg: string) => void): Promise<string | null> {
  const archive = join(BIN_DIR, 'mingit.zip')
  try {
    await mkdir(BIN_DIR, { recursive: true })
    onStatus?.('Downloading portable git…')
    logger.info(`[git] downloading portable MinGit from ${MINGIT_URL}`)
    await rm(archive, { force: true })
    await downloadUrl(MINGIT_URL, archive, () => {}, undefined, { minBytes: 5_000_000 })
    await rm(GIT_HOME, { recursive: true, force: true })
    await extractArchive(archive, GIT_HOME)
    const found = await findFileInTree(GIT_HOME, 'git.exe')
    if (found && await works(found)) {
      logger.info(`[git] installed portable git → ${found}`)
      return found
    }
    return null
  } catch (err) {
    logger.warn(`[git] portable git install failed: ${err instanceof Error ? err.message : err}`)
    return null
  } finally {
    await rm(archive, { force: true }).catch(() => {})
  }
}

/**
 * Resolve a working `git`, bootstrapping a portable one on Windows if needed. Idempotent and
 * memoized. Throws with an actionable message when git can't be provisioned (fresh macOS/Linux
 * with no git installed), so the caller can surface it instead of a cryptic ENOENT.
 */
export async function ensureGit(onStatus?: (msg: string) => void): Promise<string> {
  if (resolvedGit !== 'git' && existsSync(resolvedGit)) return resolvedGit
  if (resolvePromise) return resolvePromise
  resolvePromise = (async () => {
    // 1) git already on PATH?
    if (await works('git')) { resolvedGit = 'git'; return resolvedGit }
    // 2) previously-downloaded portable copy?
    const existing = await findFileInTree(GIT_HOME, IS_WIN ? 'git.exe' : 'git').catch(() => null)
    if (existing && await works(existing)) { resolvedGit = existing; return resolvedGit }
    // 3) download a portable git (Windows only).
    if (IS_WIN) {
      const dl = await downloadManagedWindows(onStatus)
      if (dl) { resolvedGit = dl; return resolvedGit }
      throw new Error('Could not install a portable git automatically. Install Git for Windows from https://git-scm.com/download/win and relaunch.')
    }
    // 4) macOS/Linux: no prompt-free portable git to fetch.
    const hint = process.platform === 'darwin'
      ? 'Install it with: xcode-select --install  (or `brew install git`), then relaunch.'
      : 'Install it with your package manager (e.g. `sudo apt install git`), then relaunch.'
    throw new Error(`git is required for this feature but was not found on PATH. ${hint}`)
  })().finally(() => { resolvePromise = null })
  return resolvePromise
}
