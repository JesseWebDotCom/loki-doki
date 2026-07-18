import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Download, Rss, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'sonner'
import { getRssToken, importOpml, listFolders } from '@/lib/videos/api'

// Portability: subscriptions in and out, plus RSS feeds any reader can subscribe to.
// Lock-in is disqualifying to this audience, and "your follows are yours" is the honest
// posture for a private hub.
export function SettingsVideosPortability() {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)
  const { data: tokenData } = useQuery({ queryKey: ['videos-rss-token'], queryFn: getRssToken, staleTime: 60 * 60_000 })
  const { data: foldersData } = useQuery({ queryKey: ['videos-folders'], queryFn: listFolders, staleTime: 60_000 })
  const folders = foldersData?.folders ?? []

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const feedBase = tokenData ? `${origin}${tokenData.base}` : null

  const copy = async (url: string) => {
    try { await navigator.clipboard.writeText(url); toast.success('Feed URL copied') }
    catch { toast.error('Could not copy') }
  }

  async function onFile(file: File) {
    setImporting(true)
    try {
      const opml = await file.text()
      const r = await importOpml(opml)
      if (r.total === 0) {
        toast.error("That file didn't contain any subscriptions we recognize")
      } else {
        const bits = [`${r.imported} added`]
        if (r.skipped) bits.push(`${r.skipped} already followed`)
        if (r.unsupported) bits.push(`${r.unsupported} unsupported`)
        toast.success(bits.join(', '))
        void qc.invalidateQueries({ queryKey: ['videos-follows'] })
        void qc.invalidateQueries({ queryKey: ['yt-subs'] })
      }
    } catch {
      toast.error('Could not read that file')
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-semibold">Your subscriptions are yours</p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Bring them in from another app, take them out whenever, or read them in any RSS
          reader. Nothing here is locked to this server.
        </p>
      </div>

      <Card className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Import subscriptions</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              An OPML file from YouTube Takeout, NewPipe, FreeTube, Invidious, Grayjay, or
              this app's own export. Creators you already follow are skipped.
            </p>
          </div>
          <Button variant="outline" size="sm" disabled={importing}
            onClick={() => fileRef.current?.click()} className="shrink-0 gap-1.5">
            {importing ? <Spinner className="size-3.5" /> : <Upload className="size-3.5" />} Import
          </Button>
        </div>
        <input ref={fileRef} type="file" accept=".opml,.xml,text/xml,text/x-opml" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f) }} />

        <div className="flex items-start justify-between gap-3 border-t border-border/40 pt-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Export subscriptions</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Every channel and creator you follow, as an OPML file any other app can read.
            </p>
          </div>
          <Button asChild variant="outline" size="sm" className="shrink-0 gap-1.5">
            <a href="/api/videos/opml/export" download><Download className="size-3.5" /> Export</a>
          </Button>
        </div>
      </Card>

      <Card className="space-y-3 p-4">
        <div>
          <p className="flex items-center gap-1.5 text-sm font-medium"><Rss className="size-3.5" /> RSS feeds</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Point any RSS reader at these. The link contains a private key for your account,
            so treat it like a password and only share it with your own apps.
          </p>
        </div>
        {!feedBase ? (
          <Spinner className="size-4" />
        ) : folders.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Make a subscription folder to get a feed for it. Individual creators also have
            feeds; they're in the OPML export above.
          </p>
        ) : (
          <div className="space-y-2">
            {folders.map((f) => {
              const url = `${feedBase}/folder/${f.id}`
              return (
                <div key={f.id} className="flex items-center gap-2">
                  <span className="w-28 shrink-0 truncate text-xs font-medium">{f.name}</span>
                  {/* design-ok(mobile-input-zoom): readOnly field, never opens the keyboard so iOS won't focus-zoom */}
                  <Input readOnly value={url} className="h-8 flex-1 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                  <Button variant="ghost" size="icon-sm" aria-label={`Copy the ${f.name} feed URL`}
                    onClick={() => void copy(url)} className="shrink-0 text-muted-foreground hover:text-foreground">
                    <Copy className="size-3.5" />
                  </Button>
                </div>
              )
            })}
          </div>
        )}
      </Card>
    </div>
  )
}
