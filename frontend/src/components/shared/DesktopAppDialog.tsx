import { useEffect, useState } from 'react'
import { Download, ExternalLink } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { formatBytes } from '@/lib/archiveCategories'
import { cn } from '@/lib/cn'

// "Get the desktop app" dialog, opened from the profile menu. Lists the latest
// Doki Dock installers (served by this server via /api/desktop, which proxies
// and caches the GitHub Release assets) with the right platform first, plus the
// unsigned-build first-launch steps and the server address for first-run setup.

interface DesktopAssetInfo {
  name: string
  platform: 'mac' | 'win'
  arch: 'arm64' | 'x64'
  sizeBytes: number
  cached: boolean
}

interface DesktopReleaseInfo {
  version: string
  source: 'github' | 'cache'
  releasesUrl: string
  assets: DesktopAssetInfo[]
}

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
  const [release, setRelease] = useState<DesktopReleaseInfo | null>(null)
  const [error, setError] = useState<{ message: string; releasesUrl?: string } | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch('/api/desktop/release', { credentials: 'include' })
      .then(async (r) => {
        const data = await r.json() as DesktopReleaseInfo & { error?: string }
        if (cancelled) return
        if (!r.ok) {
          setRelease(null)
          setError({ message: data.error ?? 'Could not look up the latest release.', releasesUrl: data.releasesUrl })
        } else {
          setRelease(data)
        }
      })
      .catch(() => {
        if (!cancelled) setError({ message: 'Could not look up the latest release.' })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [open])

  const isMac = /Macintosh/.test(navigator.userAgent)
  const isWin = /Windows/.test(navigator.userAgent)

  // The visitor's platform first; Apple Silicon before Intel within Macs.
  const assets = [...(release?.assets ?? [])].sort((a, b) => {
    const rank = (x: DesktopAssetInfo) =>
      (isWin && x.platform === 'win') || (isMac && x.platform === 'mac') ? 0 : 1
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    if (a.platform !== b.platform) return a.platform === 'mac' ? -1 : 1
    return a.arch === 'arm64' ? -1 : 1
  })
  const preferredName = assets.find((a) =>
    isWin ? a.platform === 'win' : isMac ? a.platform === 'mac' : false,
  )?.name

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Get Doki Dock</DialogTitle>
          <DialogDescription>
            The desktop app puts your companion at the top of your Mac or Windows screen as a
            Dynamic Island, with voice, screen awareness, and a global hotkey. It connects to this
            server, so nothing leaves your home.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Spinner />
            Checking for the latest version...
          </div>
        ) : error ? (
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">{error.message}</p>
            {error.releasesUrl && (
              <Button asChild variant="secondary" className="w-full">
                <a href={error.releasesUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-4" />
                  Open the releases page
                </a>
              </Button>
            )}
          </div>
        ) : release ? (
          <div className="space-y-4">
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
                    <span className={cn('flex items-center gap-1.5 text-xs', a.name === preferredName ? 'opacity-80' : 'text-muted-foreground')}>
                      {a.cached && <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">On server</Badge>}
                      {formatBytes(a.sizeBytes)}
                    </span>
                  </a>
                </Button>
              ))}
              <p className="text-center text-caption text-muted-foreground">
                Version {release.version}
                {release.source === 'cache' && ', from this server’s local copy'}
              </p>
            </div>

            <div className="space-y-2 rounded-control bg-secondary/60 p-3 text-xs text-muted-foreground">
              <p className="font-semibold text-foreground">After installing</p>
              {(isMac || !isWin) && (
                <p>
                  macOS blocks the first open of unsigned apps: right-click Doki Dock in
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
