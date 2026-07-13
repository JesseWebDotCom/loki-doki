// Smart shelves: create/edit saved AND/OR filter rules over your library and pin
// them to the Books nav (Kavita smart-filters / BookLore magic-shelves). Rules are
// evaluated server-side against your library items.

import { useCallback, useEffect, useState } from 'react'
import { Pin, PinOff, Plus, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { listShelves, createShelf, updateShelf, deleteShelf, type Shelf, type ShelfRule, type ShelfField, type ShelfOp } from '@/lib/books/api'

const FIELDS: { value: ShelfField; label: string }[] = [
  { value: 'title', label: 'Title' }, { value: 'author', label: 'Author' },
  { value: 'contentType', label: 'Type' }, { value: 'sourceType', label: 'Source' },
  { value: 'status', label: 'Status' }, { value: 'format', label: 'Format' }, { value: 'finished', label: 'Finished' },
]
const OPS: { value: ShelfOp; label: string }[] = [
  { value: 'contains', label: 'contains' }, { value: 'is', label: 'is' }, { value: 'isNot', label: 'is not' },
]

const selectCls = 'h-9 rounded-control border border-border bg-background px-2 text-sm'

function RuleEditor({ rule, onChange, onRemove }: { rule: ShelfRule; onChange: (r: ShelfRule) => void; onRemove: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <select className={selectCls} value={rule.field} onChange={(e) => onChange({ ...rule, field: e.target.value as ShelfField })}>
        {FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
      </select>
      <select className={selectCls} value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value as ShelfOp })}>
        {OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <Input className="h-9 flex-1" value={rule.value} placeholder="value" onChange={(e) => onChange({ ...rule, value: e.target.value })} />
      <button type="button" onClick={onRemove} className="shrink-0 text-muted-foreground hover:text-destructive" aria-label="Remove rule"><X className="size-4" /></button>
    </div>
  )
}

export function SmartShelvesManager() {
  const [shelves, setShelves] = useState<Shelf[] | null>(null)
  const [name, setName] = useState('')
  const [match, setMatch] = useState<'all' | 'any'>('all')
  const [rules, setRules] = useState<ShelfRule[]>([{ field: 'author', op: 'contains', value: '' }])
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => { void listShelves().then(setShelves) }, [])
  useEffect(load, [load])

  const create = async () => {
    const clean = rules.filter((r) => r.value.trim() || r.field === 'finished')
    if (!name.trim() || !clean.length) { toast.error('Name the shelf and add at least one rule'); return }
    setBusy(true)
    try {
      const shelf = await createShelf({ name, rules: { match, rules: clean } })
      setShelves((prev) => [...(prev ?? []), shelf])
      setName(''); setRules([{ field: 'author', op: 'contains', value: '' }]); setMatch('all')
      toast.success('Shelf created')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create shelf')
    } finally {
      setBusy(false)
    }
  }

  const togglePin = async (s: Shelf) => {
    setShelves((prev) => (prev ?? []).map((x) => x.id === s.id ? { ...x, pinned: !x.pinned } : x))
    try { await updateShelf(s.id, { pinned: !s.pinned }) } catch { load(); toast.error('Could not update') }
  }
  const remove = async (s: Shelf) => {
    setShelves((prev) => (prev ?? []).filter((x) => x.id !== s.id))
    try { await deleteShelf(s.id) } catch { load(); toast.error('Could not delete') }
  }

  if (shelves === null) return <div className="flex justify-center py-6"><Spinner /></div>

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Smart shelves</h2>
        <p className="mt-1 text-sm text-muted-foreground">Saved filters over your library. Pin one to keep it in the Books sidebar.</p>
      </div>

      {shelves.length > 0 && (
        <div className="space-y-2">
          {shelves.map((s) => (
            <div key={s.id} className="flex items-center gap-3 rounded-card border border-border p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{s.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  Match {s.rules.match} · {s.rules.rules.length} rule{s.rules.rules.length === 1 ? '' : 's'}
                </p>
              </div>
              <button type="button" onClick={() => void togglePin(s)}
                className={cn('shrink-0', s.pinned ? 'text-brand' : 'text-muted-foreground hover:text-foreground')}
                aria-label={s.pinned ? 'Unpin' : 'Pin'}>
                {s.pinned ? <Pin className="size-4" /> : <PinOff className="size-4" />}
              </button>
              <button type="button" onClick={() => void remove(s)} className="shrink-0 text-muted-foreground hover:text-destructive" aria-label="Delete shelf">
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-card border border-dashed border-border p-3">
        <p className="text-sm font-medium">New shelf</p>
        <div className="mt-3 space-y-2">
          <Input value={name} placeholder="Shelf name (e.g. Sci-Fi by Asimov)" onChange={(e) => setName(e.target.value)} />
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            Match
            <select className={selectCls} value={match} onChange={(e) => setMatch(e.target.value as 'all' | 'any')}>
              <option value="all">all rules</option>
              <option value="any">any rule</option>
            </select>
          </div>
          {rules.map((r, i) => (
            <RuleEditor key={i} rule={r}
              onChange={(nr) => setRules((prev) => prev.map((x, j) => j === i ? nr : x))}
              onRemove={() => setRules((prev) => prev.filter((_, j) => j !== i))} />
          ))}
          <Button variant="ghost" size="sm" onClick={() => setRules((prev) => [...prev, { field: 'title', op: 'contains', value: '' }])}>
            <Plus className="mr-1.5 size-4" />Add rule
          </Button>
        </div>
        <div className="mt-3 flex justify-end">
          <Button disabled={busy} onClick={() => void create()}>{busy ? <Spinner size="sm" className="mr-1.5" /> : null}Create shelf</Button>
        </div>
      </div>
    </div>
  )
}
