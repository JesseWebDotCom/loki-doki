// Add/edit/remove/test custom self-hosted OPDS indexers (Calibre-Web, Kavita,
// COPS, etc.), multiple allowed. Shared between Admin > Integrations > Books
// (AdminBooksTab) and the in-app Books > Sources page's admin section, so there's
// one implementation instead of two copies of the same form.

import { useCallback, useEffect, useState } from 'react'
import { Check, Plus, Save, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/lib/toast'
import {
  listBookIndexers, createBookIndexer, updateBookIndexer, deleteBookIndexer, testBookIndexer,
  type BookIndexer,
} from '@/lib/books/api'

interface DraftState {
  label: string
  baseUrl: string
  username: string
  password: string
}

const EMPTY_DRAFT: DraftState = { label: '', baseUrl: '', username: '', password: '' }

function IndexerRow({ indexer, onChanged }: { indexer: BookIndexer; onChanged: () => void }) {
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [deleting, setDeleting] = useState(false)

  const toggle = useCallback(async () => {
    await updateBookIndexer(indexer.id, { enabled: !indexer.enabled })
    onChanged()
  }, [indexer, onChanged])

  const test = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const d = await testBookIndexer(indexer.id)
      setTestResult(d.ok ? { ok: true, message: `Connected: a test search returned ${d.resultCount} result(s)` } : { ok: false, message: d.error ?? 'Connection failed' })
    } finally {
      setTesting(false)
    }
  }, [indexer.id])

  const remove = useCallback(async () => {
    setDeleting(true)
    try {
      await deleteBookIndexer(indexer.id)
      toast.success('Removed')
      onChanged()
    } finally {
      setDeleting(false)
    }
  }, [indexer.id, onChanged])

  return (
    <div className="rounded-card border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{indexer.label}</p>
          <p className="truncate text-xs text-muted-foreground">{indexer.baseUrl}</p>
          {indexer.username && <p className="truncate text-[11px] text-muted-foreground/70">User: {indexer.username}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => void toggle()}
            title={indexer.enabled ? 'Enabled, click to disable' : 'Disabled, click to enable'}
            className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${indexer.enabled ? 'bg-success/15 text-success' : 'bg-secondary text-muted-foreground'}`}
          >
            {indexer.enabled ? 'On' : 'Off'}
          </button>
          <Button variant="ghost" size="icon-sm" disabled={deleting} onClick={() => void remove()} title="Remove">
            {deleting ? <Spinner size="sm" /> : <Trash2 className="size-4 text-destructive" />}
          </Button>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={testing} onClick={() => void test()}>
          {testing ? <Spinner size="sm" className="mr-1.5" /> : null}Test connection
        </Button>
        {testResult && (
          <p className={`flex items-center gap-1 text-xs ${testResult.ok ? 'text-success' : 'text-destructive'}`}>
            {testResult.ok ? <Check className="size-3.5" /> : <X className="size-3.5" />}{testResult.message}
          </p>
        )}
      </div>
    </div>
  )
}

export function IndexerManager() {
  const [indexers, setIndexers] = useState<BookIndexer[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setIndexers(await listBookIndexers())
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  const save = useCallback(async () => {
    if (!draft.label.trim() || !draft.baseUrl.trim()) { toast.error('Label and search URL are required'); return }
    setSaving(true)
    try {
      await createBookIndexer({
        label: draft.label.trim(), baseUrl: draft.baseUrl.trim(),
        username: draft.username.trim() || undefined, password: draft.password.trim() || undefined,
      })
      setDraft(EMPTY_DRAFT)
      setAdding(false)
      toast.success('Indexer added')
      await load()
    } catch {
      toast.error('Could not add this indexer')
    } finally {
      setSaving(false)
    }
  }, [draft, load])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Custom Indexers</CardTitle>
        <CardDescription>
          Point Discover at your own OPDS catalogs (Calibre-Web, Kavita, COPS, etc.). Add as many as you like. Use
          <code className="mx-1">{'{searchTerms}'}</code>in the URL where your server expects the query, or a plain base URL (a <code>?q=</code> parameter is appended).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : (
          <>
            {indexers.map((idx) => <IndexerRow key={idx.id} indexer={idx} onChanged={load} />)}
            {indexers.length === 0 && !adding && (
              <p className="text-sm text-muted-foreground">No custom indexers yet.</p>
            )}
          </>
        )}

        {adding ? (
          <div className="space-y-3 rounded-card border border-dashed border-border p-3">
            <div className="space-y-1.5">
              <Label htmlFor="idx-label">Label</Label>
              <Input id="idx-label" value={draft.label} onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))} placeholder="My Calibre-Web" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="idx-url">OPDS search URL</Label>
              <Input id="idx-url" value={draft.baseUrl} onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
                placeholder="https://books.home.lan/opds/search?query={searchTerms}" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="idx-user">Username (optional)</Label>
                <Input id="idx-user" value={draft.username} onChange={(e) => setDraft((d) => ({ ...d, username: e.target.value }))} placeholder="admin" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="idx-pass">Password (optional)</Label>
                <Input id="idx-pass" type="password" value={draft.password} onChange={(e) => setDraft((d) => ({ ...d, password: e.target.value }))} />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={saving} onClick={() => void save()}>
                {saving ? <Spinner size="sm" className="mr-1.5" /> : <Save className="mr-1.5 size-4" />}Add
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setDraft(EMPTY_DRAFT) }}>Cancel</Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus className="mr-1.5 size-4" />Add indexer
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
