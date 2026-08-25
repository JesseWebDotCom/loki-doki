import { useCallback, useEffect, useState } from 'react'
import { BookAudio, BookOpenCheck, FileText, Globe, Mic2, Search, Sparkles } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/lib/toast'
import { getBookSources, getGoogleBooksKeyStatus, getIaLicenseCheck, setBookSourceToggle, setGoogleBooksApiKey, setIaLicenseCheck, type BuiltinSource, type BuiltinSourceToggles } from '@/lib/books/api'

const SOURCES: { key: BuiltinSource; label: string; description: string; icon: typeof BookAudio }[] = [
  { key: 'gutenberg', label: 'Project Gutenberg', description: 'Downloadable EPUB books and genre shelves.', icon: BookAudio },
  { key: 'archiveorg', label: 'Internet Archive', description: 'Scanned books, comics, PDFs, and downloadable editions.', icon: Globe },
  { key: 'librivox', label: 'LibriVox', description: 'Streamable MP3 audiobooks hosted by Internet Archive.', icon: Mic2 },
  { key: 'standardebooks', label: 'Standard Ebooks', description: 'Curated, carefully formatted EPUB releases.', icon: Sparkles },
  { key: 'wikisource', label: 'Wikisource', description: 'Community-proofread works exported as EPUB.', icon: FileText },
  { key: 'googlebooks', label: 'Google Books Previews', description: 'Modern books with publisher-authorized samples. Set GOOGLE_BOOKS_API_KEY on the server for reliable catalog access.', icon: BookOpenCheck },
  { key: 'openlibrary', label: 'Open Library', description: 'Large keyless catalog covering current books, comics, manga, editions, and reading availability.', icon: Globe },
  { key: 'web', label: 'Web Search', description: 'Trusted public-book pages discovered through the configured web-search engines.', icon: Search },
]

export function BookSourceManager() {
  const [toggles, setToggles] = useState<BuiltinSourceToggles | null>(null)
  const [saving, setSaving] = useState<BuiltinSource | null>(null)
  const [googleKey, setGoogleKey] = useState('')
  const [googleKeyConfigured, setGoogleKeyConfigured] = useState(false)
  const [licenseCheck, setLicenseCheck] = useState(true)

  useEffect(() => { void getBookSources().then((result) => setToggles(result.toggles)) }, [])
  useEffect(() => { void getGoogleBooksKeyStatus().then(setGoogleKeyConfigured) }, [])
  useEffect(() => { void getIaLicenseCheck().then(setLicenseCheck) }, [])

  const flipLicenseCheck = useCallback(async (enabled: boolean) => {
    setLicenseCheck(enabled)
    try {
      await setIaLicenseCheck(enabled)
      toast.success(enabled ? 'License check enabled' : 'License check disabled')
    } catch (error) {
      setLicenseCheck(!enabled)
      toast.error(error instanceof Error ? error.message : 'Could not update the license check')
    }
  }, [])

  const flip = useCallback(async (source: BuiltinSource, enabled: boolean) => {
    if (!toggles) return
    const previous = toggles
    setToggles({ ...toggles, [source]: enabled })
    setSaving(source)
    try {
      await setBookSourceToggle(source, enabled)
      toast.success(`${SOURCES.find((item) => item.key === source)?.label ?? 'Source'} ${enabled ? 'enabled' : 'disabled'}`)
    } catch (error) {
      setToggles(previous)
      toast.error(error instanceof Error ? error.message : 'Could not update the source')
    } finally {
      setSaving(null)
    }
  }, [toggles])

  if (!toggles) return <div className="flex justify-center py-6"><Spinner /></div>

  const row = (source: { key: BuiltinSource; label: string; description: string; icon: typeof BookAudio }) => {
    const Icon = source.icon
    return (
      <div key={source.key} className="flex items-center gap-3 rounded-card border border-border p-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-secondary">
          <Icon className="size-4 text-muted-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{source.label}</p>
          <p className="text-xs text-muted-foreground">{source.description}</p>
        </div>
        <Switch checked={toggles[source.key]} disabled={saving !== null}
          onCheckedChange={(enabled) => void flip(source.key, enabled)} aria-label={`Toggle ${source.label}`} />
      </div>
    )
  }

  return (
    <section>
      <h3 className="text-sm font-semibold">Built-in Sources</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">Controls apply to every user of this MaiPai Home instance.</p>
      <div className="mt-3 space-y-2">{SOURCES.map(row)}</div>

      <div className="mt-6 flex items-center gap-3 rounded-card border border-border p-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Internet Archive license check</p>
          <p className="text-xs text-muted-foreground">
            Only allow direct downloads of items with a public-domain license. Disable only for testing and troubleshooting, then turn it back on: while off, items without a clear license can be downloaded by anyone in the household.
          </p>
          {!licenseCheck && (
            <p className="mt-1 text-xs font-medium text-warning">
              License check is off. Re-enable it when you finish troubleshooting.
            </p>
          )}
        </div>
        <Switch checked={licenseCheck} onCheckedChange={(enabled) => void flipLicenseCheck(enabled)} aria-label="Toggle Internet Archive license check" />
      </div>

      <div className="mt-6 rounded-card border border-border p-3">
        <p className="text-sm font-medium">Google Books API key</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {googleKeyConfigured ? 'A key is configured. Enter a new key only to replace it.' : 'Required for reliable modern catalog search and previews.'}
        </p>
        <div className="mt-3 flex gap-2">
          <Input type="password" value={googleKey} onChange={(event) => setGoogleKey(event.target.value)} placeholder="Google Books API key" />
          <Button disabled={!googleKey.trim()} onClick={() => void setGoogleBooksApiKey(googleKey).then(() => {
            setGoogleKey(''); setGoogleKeyConfigured(true); toast.success('Google Books API key saved')
          }).catch((error: unknown) => toast.error(error instanceof Error ? error.message : 'Could not save API key'))}>Save</Button>
        </div>
      </div>
    </section>
  )
}
