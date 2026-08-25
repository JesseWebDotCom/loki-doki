// One-time migration for hubs that installed before the MaiPai rename.
//
// Those hubs track the old repository (JesseWebDotCom/loki-doki). Its final
// commit carries this code, so the first boot after that update runs here:
// repoint origin to getmaipai/home, fetch, and re-graft the local main onto
// the new history (the trees are identical at cutover, so no working file
// changes except the wakeword models handled below). Future self-updates
// then fast-forward from the new repository like any fresh install.
//
// Wake word models the household already uses are tracked files in the old
// repository but local data in the new one; they are snapshotted before the
// re-graft and restored after, so nobody's wake word stops working.
//
// Safe to run every boot: it exits immediately unless origin still points at
// the old repository. Remove once no install predates the rename.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const execFileAsync = promisify(execFile)

const OLD_REPO_MARKER = 'jessewebdotcom/loki-doki'
const NEW_REPO_URL = 'https://github.com/getmaipai/home.git'
const REPO_ROOT = resolve(process.cwd(), '..')
const WAKEWORD_DIR = join(REPO_ROOT, 'data', 'voice', 'wakewords')

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', `safe.directory=${REPO_ROOT.replace(/\\/g, '/')}`, ...args], {
    cwd: REPO_ROOT,
    timeout: 120_000,
  })
  return stdout.trim()
}

export async function migrateLegacyRemote(): Promise<void> {
  try {
    if (!existsSync(join(REPO_ROOT, '.git'))) return
    const origin = (await git(['remote', 'get-url', 'origin']).catch(() => '')).toLowerCase()
    if (!origin.includes(OLD_REPO_MARKER)) return

    console.log('[cutover] repointing origin to the MaiPai repository…')

    // Preserve the household's wake word models across the re-graft.
    const stash = join(REPO_ROOT, 'data', '.wakeword-cutover-stash')
    if (existsSync(WAKEWORD_DIR)) {
      mkdirSync(stash, { recursive: true })
      for (const f of readdirSync(WAKEWORD_DIR)) {
        if (f.endsWith('.onnx') || f.endsWith('.json')) {
          cpSync(join(WAKEWORD_DIR, f), join(stash, f))
        }
      }
    }

    await git(['remote', 'set-url', 'origin', NEW_REPO_URL])
    await git(['fetch', 'origin', '--tags', '--force'])
    await git(['checkout', '-B', 'main', 'origin/main'])

    // Restore models the new tree does not carry; never overwrite what the
    // new tree ships (the MaiPai model and its manifest).
    if (existsSync(stash)) {
      mkdirSync(WAKEWORD_DIR, { recursive: true })
      for (const f of readdirSync(stash)) {
        const dest = join(WAKEWORD_DIR, f)
        if (!existsSync(dest)) cpSync(join(stash, f), dest)
      }
    }

    console.log('[cutover] done: origin is getmaipai/home, main tracks the new history')
  } catch (err) {
    console.error('[cutover] migration failed (will retry next boot):', err instanceof Error ? err.message : err)
  }
}
