import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { requireAdmin, requireAuth } from '@/middleware/auth'
import { dataDir } from '@/lib/download'
import type { AppEnv } from '@/types'

// MaiPai Desktop (the desktop app) installer delivery, fully local: the server
// builds the installer itself from the bundled desktop/ source (admin-triggered)
// and serves the result from data/desktop-installers/. No app store, no GitHub;
// household members download straight from this server. A server can only build
// installers for its own OS (dmg requires macOS), so admins on a different
// platform drop externally built installers into the same directory.

const DESKTOP_SRC_DIR = resolve(process.cwd(), '../desktop')
const RELEASE_OUT_DIR = join(DESKTOP_SRC_DIR, 'release')
const INSTALLERS_DIR = join(dataDir, 'desktop-installers')
const STEP_TIMEOUT_MS = 30 * 60 * 1000

export interface DesktopAsset {
  name: string
  platform: 'mac' | 'win'
  arch: 'arm64' | 'x64'
  sizeBytes: number
  builtAt: number
  version: string | null
}

function classifyAsset(name: string): Pick<DesktopAsset, 'platform' | 'arch'> | null {
  const lower = name.toLowerCase()
  if (lower.endsWith('.exe')) return { platform: 'win', arch: 'x64' }
  if (lower.endsWith('.dmg')) return { platform: 'mac', arch: lower.includes('arm64') ? 'arm64' : 'x64' }
  // Mac apps also ship as plain zips (the Windows-built cross-compile pipeline
  // produces these, and electron-builder emits them next to every dmg).
  if (lower.endsWith('.zip') && (lower.includes('mac') || lower.includes('darwin'))) {
    return { platform: 'mac', arch: lower.includes('arm64') ? 'arm64' : 'x64' }
  }
  return null
}

function assetVersion(name: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(name)?.[1] ?? null
}

function appVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(DESKTOP_SRC_DIR, 'package.json'), 'utf8')) as { version?: string }
    return pkg.version ?? null
  } catch {
    return null
  }
}

function listAssets(): DesktopAsset[] {
  if (!existsSync(INSTALLERS_DIR)) return []
  const assets: DesktopAsset[] = []
  for (const name of readdirSync(INSTALLERS_DIR)) {
    const kind = classifyAsset(name)
    if (!kind) continue
    const stat = statSync(join(INSTALLERS_DIR, name))
    if (!stat.isFile()) continue
    assets.push({ name, ...kind, sizeBytes: stat.size, builtAt: stat.mtimeMs, version: assetVersion(name) })
  }
  // A dmg and a zip of the same Mac build can coexist (electron-builder emits
  // both); offer only the dmg in that case.
  return assets.filter((a) =>
    !(a.platform === 'mac' && a.name.toLowerCase().endsWith('.zip') &&
      assets.some((b) => b.platform === 'mac' && b.arch === a.arch && b.name.toLowerCase().endsWith('.dmg'))))
}

function serverPlatform(): 'win' | 'mac' | 'linux' {
  return process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'
}

function canBuildHere(): boolean {
  // dmg images can only be produced on macOS, and electron-builder.yml declares
  // no Linux target, so only a Windows or macOS server can build its own installer.
  return (process.platform === 'win32' || process.platform === 'darwin') &&
    existsSync(join(DESKTOP_SRC_DIR, 'package.json'))
}

// ── Build runner (one at a time, survives SSE client disconnects) ─────────────

interface DesktopBuild {
  status: 'running' | 'done' | 'error'
  lines: string[]
  error?: string
  startedAt: number
}

let currentBuild: DesktopBuild | null = null

function push(b: DesktopBuild, line: string) {
  const trimmed = line.trim()
  if (trimmed) b.lines.push(trimmed)
}

function runStep(bin: string, args: string[], onLine: (line: string) => void): Promise<void> {
  return new Promise((res, rej) => {
    const proc = spawn(bin, args, {
      cwd: DESKTOP_SRC_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let lastLine = ''
    let buf = ''
    const onData = (chunk: Buffer) => {
      buf += chunk.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const l of lines) {
        const line = l.trim()
        if (!line) continue
        lastLine = line
        onLine(line)
      }
    }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)
    const timer = setTimeout(() => {
      proc.kill()
      rej(new Error(`${bin} ${args.join(' ')} timed out after ${STEP_TIMEOUT_MS / 60000} minutes`))
    }, STEP_TIMEOUT_MS)
    proc.on('error', (err) => { clearTimeout(timer); rej(err) })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) res()
      else rej(new Error(`${bin} ${args.join(' ')} exited with code ${code}${lastLine ? `: ${lastLine}` : ''}`))
    })
  })
}

// electron-builder's own extraction of its winCodeSign tooling fails on stock
// Windows: the archive holds two macOS .dylib symlinks, creating symlinks needs
// Developer Mode / admin rights, and 7za's exit code 2 aborts the build even
// though a Windows build never touches those files. Pre-seeding the cache with
// the same archive, tolerating exactly that exit code, makes builds work on any
// Windows home server. Version pinned to what electron-builder 25 requests.
const WINCODESIGN = 'winCodeSign-2.6.0'
const WINCODESIGN_URL = `https://github.com/electron-userland/electron-builder-binaries/releases/download/${WINCODESIGN}/${WINCODESIGN}.7z`

async function ensureWinCodeSignCache(onLine: (line: string) => void): Promise<void> {
  if (process.platform !== 'win32') return
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  const cacheRoot = join(localAppData, 'electron-builder', 'Cache', 'winCodeSign')
  const versionDir = join(cacheRoot, WINCODESIGN)
  if (existsSync(versionDir)) return

  onLine('Preparing Windows build tooling (one-time download)...')
  // Runs after `bun install`, so the desktop app's bundled 7za is present.
  const sevenZip = join(DESKTOP_SRC_DIR, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe')
  if (!existsSync(sevenZip)) throw new Error('7za.exe not found in desktop/node_modules; did bun install fail?')

  const tmpDir = join(cacheRoot, `.tmp-${Date.now()}`)
  mkdirSync(tmpDir, { recursive: true })
  try {
    const archive = join(tmpDir, `${WINCODESIGN}.7z`)
    const res = await fetch(WINCODESIGN_URL, { signal: AbortSignal.timeout(5 * 60 * 1000) })
    if (!res.ok) throw new Error(`Downloading ${WINCODESIGN} failed (${res.status})`)
    await Bun.write(archive, res)

    const outDir = join(tmpDir, 'out')
    await new Promise<void>((res2, rej) => {
      const proc = spawn(sevenZip, ['x', '-y', archive, `-o${outDir}`], { stdio: 'ignore', windowsHide: true })
      proc.on('error', rej)
      // Exit 2 = warnings; here that is only the two macOS symlinks failing.
      proc.on('close', (code) => (code === 0 || code === 2) ? res2() : rej(new Error(`7za exited with code ${code}`)))
    })
    if (!existsSync(join(outDir, 'rcedit-x64.exe'))) throw new Error(`${WINCODESIGN} extraction produced no tooling`)
    renameSync(outDir, versionDir)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

/** Move freshly built installers into the served directory, replacing older
 *  builds for the same platform (a Windows build supersedes every .exe, never
 *  a manually dropped Mac .dmg). */
function collectArtifacts(): string[] {
  if (!existsSync(RELEASE_OUT_DIR)) return []
  const produced = readdirSync(RELEASE_OUT_DIR).filter((n) => classifyAsset(n) !== null)
  if (produced.length === 0) return []
  mkdirSync(INSTALLERS_DIR, { recursive: true })
  const platforms = new Set(produced.map((n) => classifyAsset(n)!.platform))
  for (const existing of readdirSync(INSTALLERS_DIR)) {
    const kind = classifyAsset(existing)
    if (kind && platforms.has(kind.platform)) unlinkSync(join(INSTALLERS_DIR, existing))
  }
  for (const name of produced) copyFileSync(join(RELEASE_OUT_DIR, name), join(INSTALLERS_DIR, name))
  return produced
}

function startBuild(): DesktopBuild {
  if (currentBuild?.status === 'running') return currentBuild
  const b: DesktopBuild = { status: 'running', lines: [], startedAt: Date.now() }
  currentBuild = b
  void (async () => {
    try {
      // Drop artifacts from earlier builds so collectArtifacts() only ever
      // picks up what this run produced (a version bump would otherwise
      // republish the old installer alongside the new one).
      if (existsSync(RELEASE_OUT_DIR)) {
        for (const name of readdirSync(RELEASE_OUT_DIR)) {
          if (classifyAsset(name)) unlinkSync(join(RELEASE_OUT_DIR, name))
        }
      }
      push(b, 'Installing desktop dependencies (bun install)...')
      await runStep('bun', ['install'], (l) => push(b, l))
      await ensureWinCodeSignCache((l) => push(b, l))
      const args = process.platform === 'win32' ? ['--win', '--x64'] : ['--mac', '--arm64', '--x64']
      push(b, `Building the ${serverPlatform() === 'win' ? 'Windows' : 'Mac'} installer (electron-builder)...`)
      await runStep('bun', ['x', 'electron-builder', ...args], (l) => push(b, l))
      const produced = collectArtifacts()
      if (produced.length === 0) throw new Error('The build finished but produced no installer files')
      push(b, `Installer ready: ${produced.join(', ')}`)
      b.status = 'done'
    } catch (err) {
      b.error = String(err)
      b.status = 'error'
    }
  })()
  return b
}

const desktopApp = new Hono<AppEnv>()

// ── Available installers + build capability ───────────────────────────────────

desktopApp.get('/release', requireAuth, (c) => {
  return c.json({
    version: appVersion(),
    serverPlatform: serverPlatform(),
    canBuild: canBuildHere(),
    building: currentBuild?.status === 'running',
    assets: listAssets(),
  })
})

// ── Build the installer on this server — streams SSE progress ─────────────────
// Attaches to an already-running build instead of starting a second one, so a
// reopened dialog resumes the live log. The build itself keeps running if the
// client disconnects.

desktopApp.post('/build', requireAdmin, (c) => {
  if (!canBuildHere()) {
    const why = serverPlatform() === 'linux'
      ? 'This server runs Linux, which has no MaiPai Desktop installer target. Build on a Mac or Windows machine and drop the file into data/desktop-installers.'
      : 'The desktop app source (desktop/) was not found next to the server.'
    return c.json({ error: why }, 400)
  }
  const build = startBuild()

  return streamSSE(c, async (stream) => {
    let aborted = false
    stream.onAbort(() => { aborted = true })
    let sent = 0
    await stream.writeSSE({ event: 'start', data: JSON.stringify({ startedAt: build.startedAt }) })
    while (!aborted) {
      while (sent < build.lines.length) {
        await stream.writeSSE({ event: 'progress', data: JSON.stringify({ line: build.lines[sent++] }) })
      }
      if (build.status === 'done') {
        await stream.writeSSE({ event: 'done', data: JSON.stringify({ assets: listAssets() }) })
        return
      }
      if (build.status === 'error') {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: build.error }) })
        return
      }
      await new Promise((r) => setTimeout(r, 400))
    }
  })
})

// ── Installer download, straight off the server's disk ────────────────────────

desktopApp.get('/download/:name', requireAuth, (c) => {
  const name = c.req.param('name')
  if (!name || /[/\\]/.test(name) || name.includes('..')) return c.json({ error: 'Invalid asset name' }, 400)
  if (!classifyAsset(name)) return c.json({ error: 'Unknown installer' }, 404)

  const path = join(INSTALLERS_DIR, name)
  if (!existsSync(path)) return c.json({ error: 'Installer not found. An admin can build it from the profile menu.' }, 404)

  const file = Bun.file(path)
  const contentType = name.toLowerCase().endsWith('.dmg') ? 'application/x-apple-diskimage' : 'application/octet-stream'
  // Hand Bun the file itself (not a stream): a streamed body goes out chunked
  // with no Content-Length, so the browser can't show progress on an 80 MB file.
  return new Response(file, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(file.size),
      'Content-Disposition': `attachment; filename="${name.replace(/["\r\n]/g, '_')}"`,
    },
  })
})

export { desktopApp }
