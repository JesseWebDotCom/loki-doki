import { useCallback, useEffect, useMemo, useState } from 'react'
import { Brain, Check, Loader2, Pencil, Pin, PinOff, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useActiveCompanion } from '@/hooks/useActiveCompanion'

// "What I know about you" — the user's own view of the companion memory store.
// Shared-brain rows (characterId null) are what EVERY companion knows; rows scoped
// to a character are that companion's private texture (e.g. first-met).

interface MemoryRow {
  id: string
  text: string
  sourceText: string | null
  category: string
  tier: 'durable' | 'episodic'
  importance: number
  pinned: boolean
  characterId: string | null
  /** Family-shared scope — visible to (and manageable by) everyone in the home. */
  household: boolean
  createdAt: string
  updatedAt: string | null
}

const CATEGORY_LABEL: Record<string, string> = {
  person: 'person', place: 'place', thing: 'thing', preference: 'preference',
  identity: 'identity', event: 'event', project: 'project', goal: 'goal',
  relationship: 'relationship', fact: 'fact', state: 'recent',
}

export function SettingsMemoryTab() {
  const [rows, setRows] = useState<MemoryRow[] | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const { companions } = useActiveCompanion()

  const charName = useCallback(
    (id: string | null) => (id ? companions.find((c) => c.id === id)?.name ?? 'a companion' : null),
    [companions],
  )

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/memory', { credentials: 'include' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setRows(await res.json() as MemoryRow[])
    } catch {
      toast.error('Could not load memories')
      setRows([])
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const shared = useMemo(() => (rows ?? []).filter((r) => !r.characterId && !r.household), [rows])
  const household = useMemo(() => (rows ?? []).filter((r) => r.household), [rows])
  const perCharacter = useMemo(() => (rows ?? []).filter((r) => r.characterId && !r.household), [rows])

  const remove = async (row: MemoryRow) => {
    const res = await fetch(`/api/memory/${row.id}`, { method: 'DELETE', credentials: 'include' })
    if (res.ok) {
      setRows((prev) => (prev ?? []).filter((r) => r.id !== row.id))
      toast.success('Forgotten')
    } else {
      toast.error('Could not forget that')
    }
  }

  const togglePin = async (row: MemoryRow) => {
    const res = await fetch(`/api/memory/${row.id}`, {
      method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: !row.pinned }),
    })
    if (res.ok) setRows((prev) => (prev ?? []).map((r) => r.id === row.id ? { ...r, pinned: !row.pinned } : r))
    else toast.error('Could not update')
  }

  const saveEdit = async (row: MemoryRow) => {
    const text = editText.trim()
    setEditingId(null)
    if (!text || text === row.text) return
    const res = await fetch(`/api/memory/${row.id}`, {
      method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (res.ok) {
      setRows((prev) => (prev ?? []).map((r) => r.id === row.id ? { ...r, text } : r))
      toast.success('Corrected')
    } else {
      toast.error('Could not save the correction')
    }
  }

  const clearShared = async () => {
    setConfirmClear(false)
    const res = await fetch('/api/memory?scope=shared', { method: 'DELETE', credentials: 'include' })
    if (res.ok) {
      const { forgotten } = await res.json() as { forgotten: number }
      toast.success(`Forgot ${forgotten} memories`)
      void load()
    } else {
      toast.error('Could not clear memories')
    }
  }

  const renderRow = (row: MemoryRow) => (
    <li key={row.id} className="flex items-start gap-2 rounded-md border border-border px-3 py-2">
      <div className="min-w-0 flex-1">
        {editingId === row.id ? (
          <div className="flex items-center gap-1">
            <input
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void saveEdit(row); if (e.key === 'Escape') setEditingId(null) }}
              className="ld-input flex-1 text-sm"
              autoFocus
            />
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void saveEdit(row)} title="Save"><Check className="h-3.5 w-3.5" /></Button>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditingId(null)} title="Cancel"><X className="h-3.5 w-3.5" /></Button>
          </div>
        ) : (
          <p className="text-sm leading-snug">{row.text}</p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="rounded bg-muted px-1.5 py-0.5">{CATEGORY_LABEL[row.category] ?? row.category}</span>
          {row.tier === 'durable' && <span className="rounded bg-muted px-1.5 py-0.5">long-term</span>}
          {row.characterId && <span className="rounded bg-muted px-1.5 py-0.5">{charName(row.characterId)}</span>}
          {row.sourceText && <span className="truncate italic opacity-70" title={row.sourceText}>from: “{row.sourceText.slice(0, 80)}”</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void togglePin(row)} title={row.pinned ? 'Unpin' : 'Pin (always in context)'}>
          {row.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
        </Button>
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setEditingId(row.id); setEditText(row.text) }} title="Correct">
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => void remove(row)} title="Forget">
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </li>
  )

  if (rows === null) {
    return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading memories…</div>
  }

  return (
    <div className="max-w-3xl space-y-8">
      <section>
        <div className="mb-1 flex items-center gap-2">
          <Brain className="h-4 w-4" />
          <p className="text-sm font-medium">What your companions know about you</p>
        </div>
        <p className="mb-4 text-xs text-muted-foreground">
          Facts your companions have learned from conversations (plus anything you asked them to remember).
          You can correct, pin, or forget any of them — you can also just say “remember that…” or “forget what I said about…” in chat.
        </p>

        {shared.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
            Nothing yet — memories appear here as you chat.
          </p>
        ) : (
          <ul className="space-y-2">{shared.map(renderRow)}</ul>
        )}

        {shared.length > 0 && (
          <div className="mt-3">
            <Button variant="outline" size="sm" className="text-destructive" onClick={() => setConfirmClear(true)}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Forget everything
            </Button>
          </div>
        )}
      </section>

      {household.length > 0 && (
        <section>
          <p className="mb-1 text-sm font-medium">Household</p>
          <p className="mb-4 text-xs text-muted-foreground">
            Shared facts about the home — the dog's name, the wifi, the address. Every family member's companions know these, and anyone in the household can edit them.
          </p>
          <ul className="space-y-2">{household.map(renderRow)}</ul>
        </section>
      )}

      {perCharacter.length > 0 && (
        <section>
          <p className="mb-1 text-sm font-medium">Companion-specific memories</p>
          <p className="mb-4 text-xs text-muted-foreground">Small personal touches individual companions keep (like when you first met).</p>
          <ul className="space-y-2">{perCharacter.map(renderRow)}</ul>
        </section>
      )}

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Forget everything?"
        description="All shared memories about you will be forgotten by every companion. This can't be undone from here."
        confirmLabel="Forget everything"
        destructive
        onConfirm={() => void clearShared()}
      />
    </div>
  )
}
