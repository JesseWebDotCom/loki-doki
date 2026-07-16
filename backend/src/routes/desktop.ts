import { Hono } from 'hono'
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { requireAuth } from '@/middleware/auth'
import { dataDir } from '@/lib/download'
import { isDownloadBlocked } from '@/lib/connectivity'
import type { AppEnv } from '@/types'

// Doki Dock (the desktop app) installer delivery. Installers are published as
// GitHub Release assets on desktop-v* tags (.github/workflows/desktop-build.yml).
// This route resolves the latest release and proxies the installer through the
// server, caching a copy under data/desktop-installers/<tag>/ so repeat
// downloads by other household members (and offline-mode installs) come
// straight off the local disk.

const REPO = 'JesseWebDotCom/loki-doki'
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=15`
export const RELEASES_PAGE_URL = `https://github.com/${REPO}/releases`
const CACHE_DIR = join(dataDir, 'desktop-installers')
const RELEASE_TTL_MS = 30 * 60 * 1000

export interface DesktopAsset {
  name: string
  platform: 'mac' | 'win'
  arch: 'arm64' | 'x64'
  sizeBytes: number
  cached: boolean
  /** GitHub download URL; absent for assets known only from the disk cache. */
  url?: string
}

export interface DesktopRelease {
  tag: string
  version: string
  assets: DesktopAsset[]
}

function classifyAsset(name: string): Pick<DesktopAsset, 'platform' | 'arch'> | null {
  const lower = name.toLowerCase()
  if (lower.endsWith('.exe')) return { platform: 'win', arch: 'x64' }
  if (lower.endsWith('.dmg')) return { platform: 'mac', arch: lower.includes('arm64') ? 'arm64' : 'x64' }
  // .zip and blockmap assets exist for updater tooling; users install via dmg/exe.
  return null
}

function isCached(tag: string, name: string): boolean {
  return existsSync(join(CACHE_DIR, tag, name))
}

// Newest tag wins: compare the numeric parts of desktop-vX.Y.Z.
function tagVersion(tag: string): number[] {
  return tag.replace(/^desktop-v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0)
}

function compareTags(a: string, b: string): number {
  const va = tagVersion(a); const vb = tagVersion(b)
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (va[i] ?? 0) - (vb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** Whatever installers are already on disk, newest tag first. */
function releaseFromCache(): DesktopRelease | null {
  if (!existsSync(CACHE_DIR)) return null
  const tags = readdirSync(CACHE_DIR).filter((t) => t.startsWith('desktop-v')).sort(compareTags).reverse()
  for (const tag of tags) {
    const assets: DesktopAsset[] = []
    for (const name of readdirSync(join(CACHE_DIR, tag))) {
      const kind = classifyAsset(name)
      if (!kind || name.endsWith('.part')) continue
      assets.push({ name, ...kind, sizeBytes: statSync(join(CACHE_DIR, tag, name)).size, cached: true })
    }
    if (assets.length > 0) return { tag, version: tag.replace(/^desktop-v/, ''), assets }
  }
  return null
}

interface GhRelease {
  tag_name: string
  draft: boolean
  assets: { name: string; size: number; browser_download_url: string }[]
}

let releaseCache: { at: number; release: DesktopRelease | null } | null = null

async function fetchLatestRelease(): Promise<DesktopRelease | null> {
  if (releaseCache && Date.now() - releaseCache.at < RELEASE_TTL_MS && releaseCache.release) {
    // Re-check the cached flags cheaply; the disk can gain files between calls.
    for (const a of releaseCache.release.assets) a.cached = isCached(releaseCache.release.tag, a.name)
    return releaseCache.release
  }
  const res = await fetch(RELEASES_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'loki-doki' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`GitHub API ${res.status} fetching desktop releases`)
  const releases = await res.json() as GhRelease[]
  const latest = releases
    .filter((r) => !r.draft && r.tag_name.startsWith('desktop-v'))
    .sort((a, b) => compareTags(a.tag_name, b.tag_name))
    .pop()
  const release: DesktopRelease | null = latest
    ? {
        tag: latest.tag_name,
        version: latest.tag_name.replace(/^desktop-v/, ''),
        assets: latest.assets.flatMap((a) => {
          const kind = classifyAsset(a.name)
          return kind
            ? [{ name: a.name, ...kind, sizeBytes: a.size, cached: isCached(latest.tag_name, a.name), url: a.browser_download_url }]
            : []
        }),
      }
    : null
  releaseCache = { at: Date.now(), release }
  return release
}

async function resolveRelease(): Promise<{ release: DesktopRelease | null; source: 'github' | 'cache' }> {
  if (!(await isDownloadBlocked())) {
    try {
      const release = await fetchLatestRelease()
      if (release && release.assets.length > 0) return { release, source: 'github' }
    } catch {
      // Fall through to the disk cache; a flaky connection should not hide
      // installers we already have.
    }
  }
  return { release: releaseFromCache(), source: 'cache' }
}

const desktopApp = new Hono<AppEnv>()

// ── Latest release info ────────────────────────────────────────────────────────

desktopApp.get('/release', requireAuth, async (c) => {
  const { release, source } = await resolveRelease()
  if (!release) {
    return c.json({
      error: 'No desktop release found. Connect to the internet once so the server can reach GitHub, or check the releases page.',
      releasesUrl: RELEASES_PAGE_URL,
    }, 404)
  }
  return c.json({ ...release, source, releasesUrl: RELEASES_PAGE_URL })
})

// ── Installer download (proxied + cached) ─────────────────────────────────────

desktopApp.get('/download/:name', requireAuth, async (c) => {
  const name = c.req.param('name')
  // Asset names come from GitHub; still refuse anything path-like outright.
  if (!name || /[/\\]/.test(name) || name.includes('..')) return c.json({ error: 'Invalid asset name' }, 400)

  const { release } = await resolveRelease()
  const asset = release?.assets.find((a) => a.name === name)
  if (!release || !asset) return c.json({ error: 'Unknown installer' }, 404)

  const contentType = name.toLowerCase().endsWith('.dmg') ? 'application/x-apple-diskimage' : 'application/octet-stream'
  const headers = {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${name.replace(/["\r\n]/g, '_')}"`,
  }

  const cachedPath = join(CACHE_DIR, release.tag, name)
  if (existsSync(cachedPath)) {
    const file = Bun.file(cachedPath)
    return c.body(file.stream(), 200, { ...headers, 'Content-Length': String(file.size) })
  }

  if (await isDownloadBlocked()) return c.json({ error: 'Offline mode is active and this installer is not cached yet.' }, 503)
  if (!asset.url) return c.json({ error: 'Installer is not cached and no download source is available.' }, 503)

  const res = await fetch(asset.url, {
    headers: { 'User-Agent': 'loki-doki' },
    signal: AbortSignal.timeout(15 * 60 * 1000),
  })
  if (!res.ok || !res.body) return c.json({ error: `GitHub download failed (${res.status})` }, 502)

  // Stream to the browser while teeing a copy into the on-disk cache, so the
  // next household member's download never leaves the LAN. The cache copy
  // lands as .part and is only renamed into place when the fetch completes.
  mkdirSync(join(CACHE_DIR, release.tag), { recursive: true })
  // Unique temp name so two simultaneous first downloads never interleave
  // writes into the same partial file; last rename wins.
  const partPath = `${cachedPath}.${crypto.randomUUID()}.part`
  const [toClient, toDisk] = res.body.tee()
  void Bun.write(partPath, new Response(toDisk))
    .then(() => renameSync(partPath, cachedPath))
    .catch(() => { try { unlinkSync(partPath) } catch { /* already gone */ } })

  return c.body(toClient, 200, { ...headers, 'Content-Length': String(asset.sizeBytes) })
})

export { desktopApp }
