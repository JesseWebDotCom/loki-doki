import { useEffect, useRef, useState } from 'react'
import { Download, Hammer } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { formatBytes } from '@/lib/archiveCategories'
import { useAuth } from '@/context/AuthContext'
import { cn } from '@/lib/cn'

// "Get the desktop app" dialog, opened from the profile menu. Fully local:
// installers are built by this server from the bundled desktop/ source
// (admin-triggered, live build log) and downloaded straight off its disk via
// /api/desktop. No app store or external downloads involved.

interface DesktopAssetInfo {
  name: string
  platform: 'mac' | 'win'
  arch: 'arm64' | 'x64'
  sizeBytes: number
  version: string | null
}

interface DesktopReleaseInfo {
  version: string | null
  serverPlatform: 'win' | 'mac' | 'linux'
  canBuild: boolean
  building: boolean
  assets: DesktopAssetInfo[]
}

type BuildState =
  | { phase: 'idle' }
  | { phase: 'running'; line: string }
  | { phase: 'error'; error: string }

function assetLabel(a: DesktopAssetInfo): string {
  if (a.platform === 'win') return 'Download for Windows'
  return a.arch === 'arm64' ? 'Download for Mac (Apple Silicon)' : 'Download for Mac (Intel)'
}

export function DesktopAppDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { user } = useAuth()
  const [release, setRelease] = useState<DesktopReleaseInfo | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [build, setBuild] = useState<BuildState>({ phase: 'idle' })
  const buildingRef = useRef(false)

  async function loadRelease() {
    setLoadError(null)
    try {
      const r = await fetch('/api/desktop/release', { credentials: 'include' })
      const data = await r.json() as DesktopReleaseInfo & { error?: string }
      if (!r.ok) {
        setRelease(null)
        setLoadError(data.error ?? 'Could not check the available installers.')
      } else {
        setRelease(data)
      }
      return data
    } catch {
      setLoadError('Could not check the available installers.')
      return null
    }
  }

  async function runBuild() {
    if (buildingRef.current) return
    buildingRef.current = true
    setBuild({ phase: 'running', line: 'Starting the build...' })
    try {
      const res = await fetch('/api/desktop/build', { method: 'POST', credentials: 'include' })
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => null) as { error?: string } | null
        setBuild({ phase: 'error', error: data?.error ?? 'The build could not be started.' })
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let ev = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('event:')) { ev = line.slice(6).trim(); continue }
          if (!line.startsWith('data:')) continue
          const raw = line.slice(5).trim()
          if (!raw) continue
          try {
            const d = JSON.parse(raw) as Record<string, unknown>
            if (ev === 'progress') setBuild({ phase: 'running', line: String(d.line ?? '') })
            else if (ev === 'done') { setBuild({ phase: 'idle' }); void loadRelease(); return }
            else if (ev === 'error') { setBuild({ phase: 'error', error: String(d.error ?? 'Build failed') }); return }
          } catch { /* malformed frame */ }
        }
      }
      // Stream ended without a terminal event (e.g. proxy hiccup): re-check state.
      setBuild({ phase: 'idle' })
      void loadRelease()
    } catch {
      setBuild({ phase: 'error', error: 'Lost the connection to the build. It may still be running; reopen this dialog to check.' })
    } finally {
      buildingRef.current = false
    }
  }

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    void loadRelease().then((data) => {
      if (cancelled) return
      setLoading(false)
      // A build already running on the server (started earlier or by another
      // admin): attach to its live log instead of showing a stale idle state.
      if (data && 'building' in data && data.building && user?.role === 'admin') void runBuild()
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const isMac = /Macintosh/.test(navigator.userAgent)
  const isWin = /Windows/.test(navigator.userAgent)
  const visitorPlatform: 'mac' | 'win' | null = isMac ? 'mac' : isWin ? 'win' : null

  // The visitor's platform first; Apple Silicon before Intel within Macs.
  const assets = [...(release?.assets ?? [])].sort((a, b) => {
    const rank = (x: DesktopAssetInfo) => (x.platform === visitorPlatform ? 0 : 1)
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    if (a.platform !== b.platform) return a.platform === 'mac' ? -1 : 1
    return a.arch === 'arm64' ? -1 : 1
  })
  const preferredName = assets.find((a) => a.platform === visitorPlatform)?.name

  const isAdmin = user?.role === 'admin'
  const missingForVisitor = visitorPlatform !== null && !assets.some((a) => a.platform === visitorPlatform)
  const serverCanBuildVisitor = release?.canBuild && release.serverPlatform === visitorPlatform

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Get Doki Dock</DialogTitle>
          <DialogDescription>
            The desktop app puts your companion at the top of your Mac or Windows screen as a
            Dynamic Island, with voice, screen awareness, and a global hotkey. It is built by and
            downloaded from your own server, so nothing leaves your home.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Spinner />
            Checking the available installers...
          </div>
        ) : loadError ? (
          <p className="py-2 text-sm text-muted-foreground">{loadError}</p>
        ) : release ? (
          <div className="space-y-4">
            {assets.length > 0 && (
              <div className="space-y-2">
                {assets.map((a) => (
                  <Button
                    key={a.name}
                    asChild
                    variant={a.name === preferredName ? 'default' : 'secondary'}
                    className="w-full justify-between"
                  >
                    <a href={`/api/desktop/download/${encodeURIComponent(a.name)}`}>
                      <span className="flex items-center gap-2">
                        <Download className="size-4" />
                        {assetLabel(a)}
                      </span>
                      <span className={cn('text-xs', a.name === preferredName ? 'opacity-80' : 'text-muted-foreground')}>
                        {a.version && `v${a.version} · `}{formatBytes(a.sizeBytes)}
                      </span>
                    </a>
                  </Button>
                ))}
              </div>
            )}

            {/* Build affordance: admins build the server's own platform here. */}
            {build.phase === 'running' ? (
              <div className="flex items-start gap-2.5 rounded-control bg-secondary/60 p-3">
                <Spinner className="mt-0.5 shrink-0" />
                <div className="min-w-0 text-xs">
                  <p className="font-semibold text-foreground">Building the installer on your server</p>
                  <p className="mt-0.5 truncate text-muted-foreground" title={build.line}>{build.line}</p>
                </div>
              </div>
            ) : (
              <>
                {build.phase === 'error' && (
                  <p className="text-xs text-destructive">{build.error}</p>
                )}
                {missingForVisitor && serverCanBuildVisitor && (
                  isAdmin ? (
                    <Button variant={assets.length === 0 ? 'default' : 'secondary'} className="w-full" onClick={() => void runBuild()}>
                      <Hammer className="size-4" />
                      Build the installer on this server
                    </Button>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No installer has been built yet. Ask an admin to open this dialog and build it.
                    </p>
                  )
                )}
                {missingForVisitor && !serverCanBuildVisitor && (
                  <p className="text-xs text-muted-foreground">
                    {visitorPlatform === 'mac'
                      ? 'Mac installers can only be built on a Mac: from the project folder run "cd desktop && bun run dist:mac", then copy the .dmg into data/desktop-installers on the server.'
                      : 'This server cannot build a Windows installer. Build one with "cd desktop && bun run dist:win" on a Windows machine, then copy the .exe into data/desktop-installers on the server.'}
                  </p>
                )}
                {isAdmin && !missingForVisitor && release.canBuild && (
                  <button
                    type="button"
                    onClick={() => void runBuild()}
                    className="text-caption text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Rebuild the {release.serverPlatform === 'win' ? 'Windows' : 'Mac'} installer
                    {release.version ? ` (current source is v${release.version})` : ''}
                  </button>
                )}
              </>
            )}

            <div className="space-y-2 rounded-control bg-secondary/60 p-3 text-xs text-muted-foreground">
              <p className="font-semibold text-foreground">After installing</p>
              {(isMac || !isWin) && (
                <p>
                  macOS blocks the first open of home-built apps: right-click Doki Dock in
                  Applications, choose Open, then Open again.
                </p>
              )}
              {(isWin || !isMac) && (
                <p>Windows SmartScreen warns once: click More info, then Run anyway.</p>
              )}
              <p>
                When it asks for your server address, enter{' '}
                <code className="rounded bg-foreground/10 px-1 py-0.5 font-mono text-foreground">
                  {window.location.origin}
                </code>{' '}
                and sign in with your profile.
              </p>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
