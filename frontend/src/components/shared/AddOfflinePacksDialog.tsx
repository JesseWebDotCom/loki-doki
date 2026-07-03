import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Download } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { ArchiveIcon } from '@/components/shared/ArchiveIcon'
import { formatBytes } from '@/lib/archiveCategories'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/cn'

// Shared "add downloadable packs" picker for the Books and Reference apps. It reuses
// the admin catalog + the durable job queue (exactly what WelcomeWizard.finish() does),
// so users add offline content from inside the app instead of Admin → Features. Adding
// content is an admin action (multi-GB downloads on shared storage), so callers only
// mount this for admins.

interface CatalogVariant { key: string; label: string; approxBytes: number; description: string }
interface CatalogEntry {
  sourceId: string
  label: string
  description: string
  category: string
  bookCategory: string | null
  variants: CatalogVariant[]
  defaultVariant: string
  installed: boolean
  variantKey: string
}

async function fetchCatalog(): Promise<CatalogEntry[]> {
  const r = await fetch('/api/admin/archives/catalog', { credentials: 'include' })
  if (!r.ok) return []
  const d = (await r.json()) as { catalog?: CatalogEntry[] }
  return d.catalog ?? []
}

export function AddOfflinePacksDialog({
  open, onOpenChange, mode, accentClassName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 'books' shows book packs (bookCategory set); 'reference' shows everything else. */
  mode: 'books' | 'reference'
  /** Optional accent class for the primary button, e.g. Books' themed accent. */
  accentClassName?: string
}) {
  const { data: catalog, isLoading } = useQuery({
    queryKey: ['archive-catalog'],
    queryFn: fetchCatalog,
    enabled: open,
    staleTime: 60_000,
  })
  const [selected, setSelected] = useState<Map<string, string>>(new Map())
  const [busy, setBusy] = useState(false)

  // Available = not yet installed, matching this app's side of the book/reference split.
  const available = useMemo(
    () => (catalog ?? []).filter((e) =>
      !e.installed && (mode === 'books' ? e.bookCategory != null : e.bookCategory == null)),
    [catalog, mode],
  )

  // Group by the label that makes sense for this side: book shelf category vs reference topic.
  const byGroup = useMemo(() => {
    const m = new Map<string, CatalogEntry[]>()
    for (const e of available) {
      const g = (mode === 'books' ? e.bookCategory : e.category) || 'Other'
      if (!m.has(g)) m.set(g, [])
      m.get(g)!.push(e)
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [available, mode])

  const toggle = (e: CatalogEntry) => setSelected((prev) => {
    const next = new Map(prev)
    if (next.has(e.sourceId)) next.delete(e.sourceId)
    else next.set(e.sourceId, e.variantKey || e.defaultVariant || e.variants[0]?.key || 'maxi')
    return next
  })
  const setVariant = (sourceId: string, key: string) => setSelected((prev) => {
    const next = new Map(prev)
    if (next.has(sourceId)) next.set(sourceId, key)
    return next
  })

  const totalBytes = useMemo(() => {
    let sum = 0
    for (const [sourceId, vk] of selected) {
      const entry = available.find((e) => e.sourceId === sourceId)
      sum += entry?.variants.find((v) => v.key === vk)?.approxBytes ?? 0
    }
    return sum
  }, [selected, available])

  async function download() {
    if (!selected.size) return
    setBusy(true)
    try {
      const zimSelections = [...selected].map(([sourceId, variantKey]) => {
        const entry = available.find((e) => e.sourceId === sourceId)
        const variant = entry?.variants.find((v) => v.key === variantKey) ?? entry?.variants[0]
        return { sourceId, variantKey, label: entry?.label ?? sourceId, approxBytes: variant?.approxBytes ?? 0 }
      })
      const r = await fetch('/api/jobs/enqueue', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ zimSelections }),
      })
      if (!r.ok) throw new Error()
      toast.success(zimSelections.length === 1 ? 'Downloading in the background' : `Downloading ${zimSelections.length} in the background`)
      setSelected(new Map())
      onOpenChange(false)
    } catch {
      toast.error('Could not start the download')
    } finally {
      setBusy(false)
    }
  }

  const title = mode === 'books' ? 'Add offline books' : 'Add references'
  const subtitle = mode === 'books'
    ? 'Download book collections to read fully offline.'
    : 'Download Wikipedia and other references to browse offline.'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{subtitle}</DialogDescription>
        </DialogHeader>

        <div className="-mx-2 max-h-[52vh] overflow-y-auto px-2">
          {isLoading && (
            <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Spinner /> Loading…</div>
          )}
          {!isLoading && available.length === 0 && (
            <p className="rounded-card border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
              Everything available is already downloaded.
            </p>
          )}
          {!isLoading && byGroup.map(([group, entries]) => (
            <div key={group} className="mb-4">
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group}</p>
              <div className="space-y-1">
                {entries.map((e) => {
                  const checked = selected.has(e.sourceId)
                  const variantKey = selected.get(e.sourceId) ?? e.variantKey
                  const variant = e.variants.find((v) => v.key === variantKey) ?? e.variants[0]
                  return (
                    <div key={e.sourceId} className="flex items-center gap-3 rounded-card border border-border/60 bg-card px-3 py-2">
                      <button type="button" onClick={() => toggle(e)}
                        className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-all',
                          checked ? 'border-brand bg-brand' : 'border-border hover:border-brand/60')}
                        aria-label={checked ? 'Deselect' : 'Select'}>
                        {checked && <CheckCircle2 className="size-3 text-brand-foreground" />}
                      </button>
                      <ArchiveIcon zimIconUrl={null} category={e.category} className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{e.label}</p>
                        <p className="truncate text-xs text-muted-foreground">{e.description}</p>
                      </div>
                      {checked && e.variants.length > 1 ? (
                        <select value={variantKey} onChange={(ev) => setVariant(e.sourceId, ev.target.value)}
                          className="shrink-0 rounded-control border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand/40">
                          {e.variants.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}
                        </select>
                      ) : (
                        <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                          {formatBytes(variant?.approxBytes ?? 0) ?? '-'}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span className="text-xs text-muted-foreground tabular-nums">
            {selected.size > 0 ? `${selected.size} selected · ${formatBytes(totalBytes)}` : 'Nothing selected'}
          </span>
          <Button onClick={download} disabled={!selected.size || busy} className={accentClassName}>
            {busy ? <Spinner className="size-4" /> : <Download className="size-4" />}
            Download
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
