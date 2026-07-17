import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Download, Upload, CheckCircle2, MinusCircle, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { importOpml, opmlExportUrl, type OpmlImportResult } from '@/lib/podcast/playerApi'

/** Podcast settings - Subscriptions section: OPML export of your subscriptions and OPML
 *  import from any other podcast app. */
export function PodcastOpmlSection() {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<OpmlImportResult | null>(null)

  async function handleFile(file: File) {
    setImporting(true)
    setResult(null)
    try {
      const text = await file.text()
      const res = await importOpml(text)
      setResult(res)
      if (res.added.length > 0) {
        toast.success(`Subscribed to ${res.added.length} ${res.added.length === 1 ? 'podcast' : 'podcasts'}.`)
        await Promise.all([
          qc.invalidateQueries({ queryKey: ['podcast-shows'] }),
          qc.invalidateQueries({ queryKey: ['podcast-feed'] }),
          qc.invalidateQueries({ queryKey: ['podcast-subscriptions'] }),
        ])
      } else {
        toast.info('No new podcasts to add.')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not import the OPML file.')
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <p className="text-sm font-semibold">Export subscriptions</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Download your subscriptions as an OPML file, importable by any podcast app.
        </p>
        <Button asChild variant="outline" className="mt-3 gap-2">
          <a href={opmlExportUrl} download="podcasts.opml">
            <Download className="size-4" /> Export OPML
          </a>
        </Button>
      </Card>

      <Card className="p-4">
        <p className="text-sm font-semibold">Import subscriptions</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Bring your subscriptions over from another podcast app. Each feed in the file is subscribed for you; ones you already follow are skipped.
        </p>
        {/* design-ok(raw-input-element): visually hidden native file picker; the styled Button below triggers it */}
        <input
          ref={fileRef}
          type="file"
          accept=".opml,.xml,text/xml,text/x-opml"
          className="sr-only"
          onChange={e => { const f = e.target.files?.[0]; if (f) void handleFile(f) }}
        />
        <Button variant="outline" className="mt-3 gap-2" disabled={importing} onClick={() => fileRef.current?.click()}>
          {importing ? <Spinner className="text-current" /> : <Upload className="size-4" />}
          {importing ? 'Importing…' : 'Import OPML'}
        </Button>

        {result && (
          <div className="mt-4 space-y-2 text-xs">
            {result.added.length > 0 && (
              <p className="flex items-start gap-1.5 text-success">
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
                <span>Added: {result.added.join(', ')}</span>
              </p>
            )}
            {result.skipped.length > 0 && (
              <p className="flex items-start gap-1.5 text-muted-foreground">
                <MinusCircle className="mt-0.5 size-3.5 shrink-0" />
                <span>Already subscribed: {result.skipped.join(', ')}</span>
              </p>
            )}
            {result.failed.length > 0 && (
              <div className="flex items-start gap-1.5 text-destructive">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                <div>
                  <p>Could not subscribe:</p>
                  <ul className="mt-1 list-inside list-disc">
                    {result.failed.map((f, i) => <li key={i}>{f.title}: {f.error}</li>)}
                  </ul>
                </div>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  )
}
