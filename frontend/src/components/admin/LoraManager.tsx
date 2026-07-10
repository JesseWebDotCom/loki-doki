/**
 * LoRA manager - colocated inside the Imaging app's own Settings page
 * (Apps → Imaging → Settings → LoRA styles), surfaced as an admin-only section.
 *
 * Browse/import from CivitAI, enable/disable, and remove installed LoRA styles.
 * All endpoints under /api/admin/image-loras are admin-gated, so the caller
 * gates this behind `adminOnly`.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, CheckCircle2, Download, Search, Sparkles, Trash2, X } from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'

function qMatch(text: string, q: string): boolean {
  return text.toLowerCase().includes(q.toLowerCase())
}

// ── LoRAs browse modal ────────────────────────────────────────────────────────

interface SearchHit {
  modelId: number; versionId: number; name: string; versionName?: string
  author?: string; baseModel?: string; downloadUrl: string; fileName?: string
  sizeKb?: number; triggerTokens: string[]; sourceUrl: string
  thumbnailUrl?: string; downloadCount: number; thumbsUpCount: number; isNsfw: boolean
  allowCommercialUse?: string; allowDerivatives?: boolean; allowNoCredit?: boolean
}
interface ImportState {
  status: 'downloading' | 'done' | 'error'
  completed: number; total: number; speedBps: number; etaSeconds: number; error?: string
}
type SortOption = 'downloads' | 'relevance' | 'newest' | 'highest_rated'

function LorasBrowseModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const { user } = useAuth()
  const [inputValue, setInputValue] = useState('')
  const [query, setQuery]           = useState('')
  const [sort, setSort]             = useState<SortOption>('downloads')
  const [showAdult, setShowAdult]   = useState(false)
  const [hits, setHits]             = useState<SearchHit[]>([])
  const [searching, setSearching]   = useState(false)
  const [imports, setImports]       = useState<Map<number, ImportState>>(new Map())
  const [currentPage, setCurrentPage] = useState(0)
  const [maxPage, setMaxPage]         = useState(0)
  const [hasNextPage, setHasNextPage] = useState(false)
  const [loraNoticeSeen, setLoraNoticeSeen] = useState(false)
  const [showLoraNotice, setShowLoraNotice] = useState(false)
  const [pendingHit, setPendingHit]         = useState<SearchHit | null>(null)
  const cursorsRef  = useRef<Record<string, string>[]>([{}])
  const inputRef    = useRef<HTMLInputElement>(null)
  const resultsRef  = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!user?.id) return
    fetch(`/api/users/${user.id}/preferences`, { credentials: 'include' })
      .then(r => r.json())
      .then((p: Record<string, unknown>) => { if (p['consent.lora_license_notice'] === true) setLoraNoticeSeen(true) })
      .catch(() => {})
  }, [user?.id])

  const handleSubmit = () => {
    if (!inputValue.trim()) { setQuery(''); setHits([]); return }
    setQuery(inputValue)
  }

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    setCurrentPage(0); setMaxPage(0); setHasNextPage(false); cursorsRef.current = [{}]
  }, [query, sort])

  useEffect(() => {
    if (!query.trim()) return
    if (resultsRef.current) {
      const ctrl = new AbortController()
      let innerTimer: ReturnType<typeof setTimeout> | null = null
      const debounceRef = setTimeout(() => {
        const cursors = cursorsRef.current[currentPage] ?? {}
        const delay = currentPage === 0 ? 300 : 0
        innerTimer = setTimeout(() => {
          setSearching(true)
          fetch('/api/admin/image-loras/civitai-search', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: query.trim(), limit: 40, sort, nsfw: true, cursors }),
            credentials: 'include',
            signal: ctrl.signal,
          })
            .then(r => r.json())
            .then((d: { hits?: SearchHit[]; nextCursors?: Record<string, string>; hasNextPage?: boolean }) => {
              if (ctrl.signal.aborted) return
              setHits(d.hits ?? [])
              const next = d.hasNextPage ?? false
              setHasNextPage(next)
              if (next && d.nextCursors && !cursorsRef.current[currentPage + 1]) {
                cursorsRef.current[currentPage + 1] = d.nextCursors
              }
              setMaxPage(p => Math.max(p, currentPage))
              resultsRef.current?.scrollTo({ top: 0 })
            })
            .catch(() => {})
            .finally(() => { if (!ctrl.signal.aborted) setSearching(false) })
        }, delay)
      }, 0)
      return () => { clearTimeout(debounceRef); if (innerTimer) clearTimeout(innerTimer); ctrl.abort() }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, query, sort])

  function setImport(versionId: number, patch: Partial<ImportState>) {
    setImports(prev => {
      const next = new Map(prev)
      const cur = next.get(versionId) ?? { status: 'downloading' as const, completed: 0, total: 0, speedBps: 0, etaSeconds: 0 }
      next.set(versionId, { ...cur, ...patch })
      return next
    })
  }

  async function acceptLoraNotice() {
    if (user?.id) {
      await fetch(`/api/users/${user.id}/preferences`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 'consent.lora_license_notice': true }),
        credentials: 'include',
      }).catch(() => {})
    }
    setLoraNoticeSeen(true)
    setShowLoraNotice(false)
    if (pendingHit) { void handleImport(pendingHit); setPendingHit(null) }
  }

  function initiateImport(hit: SearchHit) {
    if (!loraNoticeSeen) { setPendingHit(hit); setShowLoraNotice(true); return }
    void handleImport(hit)
  }

  async function handleImport(hit: SearchHit) {
    if (imports.has(hit.versionId)) return
    setImport(hit.versionId, { status: 'downloading', completed: 0, total: 0, speedBps: 0, etaSeconds: 0 })
    const res = await fetch('/api/admin/image-loras/civitai-import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({
        downloadUrl: hit.downloadUrl, fileName: hit.fileName ?? `lora_v${hit.versionId}.safetensors`,
        name: hit.name, sourceUrl: hit.sourceUrl, author: hit.author, thumbnailUrl: hit.thumbnailUrl,
        triggerTokens: hit.triggerTokens, civitaiModelId: hit.modelId, versionId: hit.versionId,
        isNsfw: hit.isNsfw,
      }),
    })
    if (!res.ok || !res.body) { setImport(hit.versionId, { status: 'error', completed: 0, total: 0, speedBps: 0, etaSeconds: 0, error: 'Request failed' }); return }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = '', currentEvent = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n'); buf = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('event:')) { currentEvent = line.slice(6).trim(); continue }
        if (!line.startsWith('data:')) continue
        const raw = line.slice(5).trim(); if (!raw) continue
        try {
          const d = JSON.parse(raw) as Record<string, unknown>
          if (currentEvent === 'progress') setImport(hit.versionId, { status: 'downloading', completed: Number(d.completed ?? 0), total: Number(d.total ?? 0), speedBps: Number(d.speedBps ?? 0), etaSeconds: Number(d.etaSeconds ?? 0) })
          else if (currentEvent === 'done') { setImport(hit.versionId, { status: 'done', completed: 1, total: 1, speedBps: 0, etaSeconds: 0 }); onImported() }
          else if (currentEvent === 'error') setImport(hit.versionId, { status: 'error', completed: 0, total: 0, speedBps: 0, etaSeconds: 0, error: String(d.message ?? 'Import failed') })
        } catch { /* malformed */ }
      }
    }
  }

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="flex flex-col gap-0 p-0 w-[90vw] max-w-5xl h-[85vh] overflow-hidden">
        <DialogHeader className="shrink-0 px-5 pt-5 pb-4 border-b border-border/50">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-brand shrink-0" />
            <DialogTitle className="text-base">Browse LoRAs</DialogTitle>
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5">Search CivitAI: SDXL compatible models</p>
        </DialogHeader>

        <div className="shrink-0 px-5 py-3 border-b border-border/40 space-y-2.5">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/50 pointer-events-none" />
              <input ref={inputRef} value={inputValue} onChange={e => setInputValue(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSubmit() }}
                placeholder="Search for a style, character, concept…"
                className="w-full rounded-control border border-border bg-card pl-9 pr-9 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40" />
              {inputValue && (
                <button onClick={() => { setInputValue(''); setQuery(''); setHits([]) }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-foreground">
                  <X className="size-3.5" />
                </button>
              )}
            </div>
            <Button onClick={handleSubmit} size="icon" aria-label="Search" title="Search" className="size-10 shrink-0">
              <ArrowRight className="size-4" />
            </Button>
          </div>
          <div className="flex items-center gap-3">
            <select value={sort} onChange={e => setSort(e.target.value as SortOption)}
              className="h-8 rounded-control border border-border bg-background px-2.5 text-xs focus:outline-none focus:ring-1 focus:ring-brand/40">
              <option value="downloads">Most downloaded</option>
              <option value="highest_rated">Highest rated</option>
              <option value="newest">Newest</option>
              <option value="relevance">Relevance</option>
            </select>
            <Button type="button" variant="outline" size="sm" onClick={() => setShowAdult(v => !v)}
              className={cn('gap-1.5', showAdult ? 'border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive' : 'text-muted-foreground')}>
              {showAdult ? '🔞 Adult on' : 'Adult off'}
            </Button>
            {searching && <Spinner size="sm" className="text-muted-foreground/50 ml-auto" />}
          </div>
        </div>

        <div ref={resultsRef} className="flex-1 overflow-y-auto px-5 py-5 min-h-0">
          {!searching && hits.length === 0 && (
            <p className="py-10 text-center text-sm text-muted-foreground/60">
              {query ? `No results for "${query}"` : 'Type a style, character, or concept and press →'}
            </p>
          )}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {hits.map(hit => {
              const imp = imports.get(hit.versionId)
              const pct = imp && imp.total > 0 ? Math.round((imp.completed / imp.total) * 100) : 0
              return (
                <Card key={hit.versionId} variant="surface" className="group flex flex-col border-border/60 hover:border-brand/40 transition-colors">
                  <div className="relative aspect-[3/4] bg-muted overflow-hidden">
                    {hit.thumbnailUrl ? (
                      <img src={proxyImg(hit.thumbnailUrl)} alt="" className={cn('absolute inset-0 size-full object-cover', hit.isNsfw && !showAdult && 'blur-xl')} />
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <Sparkles className="size-8 text-muted-foreground/20" />
                      </div>
                    )}
                    {imp?.status === 'downloading' && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 gap-2 px-3">
                        <Spinner className="size-5 text-white" />
                        <div className="w-full h-1.5 rounded-full bg-white/20 overflow-hidden">
                          <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-[11px] text-white/70 tabular-nums">{pct}%</span>
                      </div>
                    )}
                    {imp?.status === 'done' && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                        <div className="flex items-center gap-1.5 rounded-full bg-success/90 px-3 py-1.5">
                          <CheckCircle2 className="size-3.5 text-success-foreground" />
                          <span className="text-xs font-semibold text-success-foreground">Added</span>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-1 p-3">
                    <p className="text-xs font-semibold leading-tight line-clamp-2">{hit.name}</p>
                    {hit.versionName && <p className="text-[10px] text-muted-foreground/50 truncate">{hit.versionName}</p>}
                    {hit.baseModel && (
                      <span className="self-start rounded-full bg-brand/10 px-1.5 py-0.5 text-[10px] font-medium text-brand leading-none">{hit.baseModel}</span>
                    )}
                    <div className="flex items-center justify-between gap-1">
                      {hit.author && <p className="text-[10px] text-muted-foreground/50 truncate">by {hit.author}</p>}
                      {hit.sourceUrl && (
                        <a href={hit.sourceUrl} target="_blank" rel="noopener noreferrer"
                          className="shrink-0 text-[10px] text-muted-foreground/40 hover:text-brand transition-colors"
                          onClick={e => e.stopPropagation()}>View ↗</a>
                      )}
                    </div>
                    {hit.triggerTokens.length > 0 && (
                      <p className="text-[10px] font-mono text-muted-foreground/70 truncate">
                        {hit.triggerTokens.slice(0, 2).join(', ')}{hit.triggerTokens.length > 2 ? '…' : ''}
                      </p>
                    )}
                    {(hit.allowCommercialUse === 'None' || hit.allowDerivatives === false) && (
                      <div className="flex flex-wrap gap-1">
                        {hit.allowCommercialUse === 'None' && (
                          <span className="rounded-full bg-warning/15 px-1.5 py-0.5 text-[9px] font-medium text-warning leading-none">Non-commercial</span>
                        )}
                        {hit.allowDerivatives === false && (
                          <span className="rounded-full bg-warning/15 px-1.5 py-0.5 text-[9px] font-medium text-warning leading-none">No derivatives</span>
                        )}
                      </div>
                    )}
                    {imp?.status === 'error' && <p className="text-[10px] text-destructive line-clamp-2">{imp.error}</p>}
                    {!imp ? (
                      <Button variant="outline" size="sm" onClick={() => initiateImport(hit)}
                        className="mt-0.5 w-full gap-1.5 text-muted-foreground">
                        <Download className="size-3" /> Add
                      </Button>
                    ) : imp.status === 'error' ? (
                      <Button variant="outline" size="sm"
                        onClick={() => { setImports(p => { const n = new Map(p); n.delete(hit.versionId); return n }); void handleImport(hit) }}
                        className="mt-0.5 w-full border-destructive/30 text-destructive hover:bg-destructive/5 hover:text-destructive">Retry</Button>
                    ) : null}
                  </div>
                </Card>
              )
            })}
          </div>
        </div>

        {(currentPage > 0 || hasNextPage) && (
          <div className="shrink-0 flex items-center justify-center gap-1.5 border-t border-border/40 px-5 py-3">
            <Button type="button" variant="outline" size="sm" disabled={currentPage === 0 || searching} onClick={() => setCurrentPage(p => p - 1)}
              className="gap-1 text-muted-foreground">← Prev</Button>
            <div className="flex items-center gap-1">
              {Array.from({ length: maxPage + (hasNextPage ? 2 : 1) }, (_, i) => (
                <Button key={i} type="button" variant="outline" size="sm" disabled={searching || i > maxPage + 1} onClick={() => setCurrentPage(i)}
                  className={cn('min-w-[2rem] px-2.5',
                    i === currentPage ? 'border-brand/50 bg-brand/10 text-brand hover:bg-brand/15 hover:text-brand' : 'text-muted-foreground')}>
                  {i + 1}
                </Button>
              ))}
            </div>
            <Button type="button" variant="outline" size="sm" disabled={!hasNextPage || searching} onClick={() => setCurrentPage(p => p + 1)}
              className="gap-1 text-muted-foreground">Next →</Button>
          </div>
        )}

        <Dialog open={showLoraNotice} onOpenChange={open => { if (!open) { setShowLoraNotice(false); setPendingHit(null) } }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Model licenses</DialogTitle>
              <DialogDescription className="sr-only">License acknowledgment for CivitAI models</DialogDescription>
            </DialogHeader>
            <p className="text-sm text-foreground leading-relaxed">
              Models on CivitAI carry individual license terms set by their creators. Some restrict commercial use or derivatives. By downloading, you agree to comply with that model&apos;s license: check the <strong>View ↗</strong> link on each card before use in any commercial or public project.
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              You&apos;ll only see this once. License badges (<span className="font-medium text-warning">Non-commercial</span> / <span className="font-medium text-warning">No derivatives</span>) appear on restricted models.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="outline" size="sm"
                onClick={() => { setShowLoraNotice(false); setPendingHit(null) }}
                className="text-muted-foreground">
                Cancel
              </Button>
              <Button type="button" size="sm"
                onClick={() => void acceptLoraNotice()}>
                Got it
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  )
}

// ── LoRA manager ──────────────────────────────────────────────────────────────

interface LoraRow {
  id: string; name: string; description: string | null; categoryName: string | null
  triggerTokens: string[]; enabled: boolean; thumbnailUrl: string | null
  styleLabel: string | null; sizeBytes: number | null; fileExists: boolean
  isAdult: boolean
}

export function LoraManager({ imageGenInstalled = true, query = '' }: { imageGenInstalled?: boolean; query?: string }) {
  const [loras, setLoras]               = useState<LoraRow[]>([])
  const [loading, setLoading]           = useState(true)
  const [browsing, setBrowsing]         = useState(false)
  const [deleting, setDeleting]         = useState<Set<string>>(new Set())
  const [toggling, setToggling]         = useState<Set<string>>(new Set())
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [showAdult, setShowAdult]       = useState(false)

  const loadLoras = useCallback(() => {
    setLoading(true)
    fetch('/api/admin/image-loras', { credentials: 'include' })
      .then(r => r.json())
      .then((rows: LoraRow[]) => setLoras(rows))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { loadLoras() }, [loadLoras])

  async function handleDelete(id: string) {
    setDeleting(prev => new Set(prev).add(id))
    await fetch(`/api/admin/image-loras/${id}`, { method: 'DELETE', credentials: 'include' }).catch(() => {})
    setLoras(prev => prev.filter(l => l.id !== id))
    setDeleting(prev => { const n = new Set(prev); n.delete(id); return n })
  }

  async function handleToggle(id: string, enabled: boolean) {
    setToggling(prev => new Set(prev).add(id))
    setLoras(prev => prev.map(l => l.id === id ? { ...l, enabled } : l))
    await fetch(`/api/admin/image-loras/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }), credentials: 'include',
    }).catch(() => {})
    setToggling(prev => { const n = new Set(prev); n.delete(id); return n })
  }

  const filtered = query
    ? loras.filter(l => qMatch(l.name, query) || qMatch(l.categoryName ?? '', query) || l.triggerTokens.some(t => qMatch(t, query)))
    : loras

  if (query && filtered.length === 0) return null

  return (
    <div className={cn('space-y-2', !imageGenInstalled && 'opacity-40 pointer-events-none')}>
      <div className="flex items-center justify-between">
        <span className="text-overline text-muted-foreground/50">
          LoRA Styles {loras.length > 0 && `· ${loras.filter(l => l.enabled).length}/${loras.length} enabled`}
        </span>
        {imageGenInstalled && (
          <div className="flex items-center gap-2">
            {loras.some(l => l.isAdult) && (
              <Button type="button" variant="outline" size="sm" onClick={() => setShowAdult(v => !v)}
                className={cn('gap-1.5', showAdult ? 'border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive' : 'text-muted-foreground')}>
                {showAdult ? '🔞 Adult on' : 'Adult off'}
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" onClick={() => setBrowsing(true)}
              className="gap-1.5 text-muted-foreground">
              <Search className="size-3" /> Browse CivitAI
            </Button>
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-1">
          <Spinner size="sm" className="size-3 text-muted-foreground/40" />
          <span className="text-xs text-muted-foreground/40">Loading…</span>
        </div>
      ) : filtered.length === 0 ? (
        <Card variant="dashed" className="flex flex-col items-center gap-2 border-border/40 py-4 text-center">
          <Sparkles className="size-5 text-muted-foreground/25" />
          <p className="text-xs text-muted-foreground/50">No LoRAs installed yet.</p>
          <Button type="button" variant="outline" size="sm" onClick={() => setBrowsing(true)}
            className="gap-1.5 text-muted-foreground">
            <Search className="size-3" /> Browse CivitAI
          </Button>
        </Card>
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar">
          {filtered.map(lora => (
            <div key={lora.id} className="shrink-0 w-24 group relative">
              <div className={cn('relative aspect-[3/4] overflow-hidden rounded-card border',
                lora.enabled ? 'border-border/60' : 'border-border/30 opacity-50')}>
                {lora.thumbnailUrl ? (
                  <img src={proxyImg(lora.thumbnailUrl)} alt="" className={cn('absolute inset-0 size-full object-cover', lora.isAdult && !showAdult && 'blur-xl')} />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center bg-muted">
                    <Sparkles className="size-5 text-muted-foreground/20" />
                  </div>
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-2 gap-1">
                  <button type="button" disabled={toggling.has(lora.id)} onClick={() => handleToggle(lora.id, !lora.enabled)}
                    className={cn('flex items-center justify-center gap-1 rounded-control py-1 text-[10px] font-medium transition-colors',
                      lora.enabled ? 'bg-white/20 text-white hover:bg-white/30' : 'bg-brand/80 text-white hover:bg-brand')}>
                    {lora.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button type="button" disabled={deleting.has(lora.id)} onClick={() => setConfirmDeleteId(lora.id)} aria-label="Remove LoRA style"
                    className="flex items-center justify-center rounded-control py-1 text-[10px] text-white/70 bg-black/30 hover:bg-destructive/70 transition-colors">
                    <Trash2 className="size-3" />
                  </button>
                </div>
              </div>
              <p className="mt-1 text-[11px] font-medium leading-tight truncate text-center">{lora.name}</p>
              {!lora.fileExists && <p className="text-[10px] text-warning text-center">Missing</p>}
            </div>
          ))}
        </div>
      )}

      {browsing && <LorasBrowseModal onClose={() => setBrowsing(false)} onImported={loadLoras} />}

      <ConfirmDialog
        open={confirmDeleteId !== null}
        onOpenChange={open => !open && setConfirmDeleteId(null)}
        title="Remove LoRA style?"
        description="This will permanently delete the style file. You can re-import it from CivitAI at any time."
        confirmLabel="Remove"
        destructive
        onConfirm={() => { if (confirmDeleteId) { void handleDelete(confirmDeleteId); setConfirmDeleteId(null) } }}
      />
    </div>
  )
}
