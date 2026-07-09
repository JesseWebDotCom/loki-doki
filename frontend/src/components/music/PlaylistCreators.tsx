// Magic Vibe + Smart Rules playlist creators, launched from the Library's Playlists tab.
//
//   Magic mix - describe a vibe, pick sonic chips and an energy arc, and the AI writes a
//   real, editable playlist (recipe saved, so it can be re-rolled from the detail page).
//   Smart playlist - live rules over YOUR music (plays, ratings, favorites, artists);
//   re-evaluated every time it's opened, so it never goes stale.

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Sparkles, Wand2 } from 'lucide-react'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import {
  createMagicPlaylist, createSmartPlaylist, previewSmartRules,
  type SmartRule, type SmartRules,
} from '@/lib/music/catalogApi'

const CHIPS = ['fast', 'slow', 'dark', 'bright', 'acoustic', 'electronic', 'happy', 'melancholy'] as const
const ARCS = [
  { key: 'flat', label: 'Steady' },
  { key: 'rise', label: 'Build up' },
  { key: 'fall', label: 'Wind down' },
  { key: 'wave', label: 'Waves' },
] as const

function ChipButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  // design-ok(hand-styled-button): filter/preset chip, not a chrome control
  return (
    <button type="button" onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs font-medium transition ${
        active ? 'bg-brand text-brand-foreground' : 'bg-foreground/8 hover:bg-foreground/15'
      }`}>
      {children}
    </button>
  )
}

export function MagicVibeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const navigate = useNavigate()
  const [vibe, setVibe] = useState('')
  const [chips, setChips] = useState<string[]>([])
  const [arc, setArc] = useState<string>('flat')
  const [count, setCount] = useState(20)
  const [busy, setBusy] = useState(false)

  const create = async () => {
    const v = vibe.trim()
    if (!v || busy) return
    setBusy(true)
    try {
      const { playlist } = await createMagicPlaylist({ vibe: v, chips, arc, count })
      toast.success(`"${playlist.name}" is ready`)
      onOpenChange(false)
      navigate(`/music/playlist/${playlist.id}`)
    } catch {
      toast.error('Could not build that mix - try rewording the vibe.')
    } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!busy) onOpenChange(v) }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Wand2 className="size-4 text-brand" /> Magic mix</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">What's the vibe?</label>
            <Input value={vibe} autoFocus placeholder="rainy Sunday coffee shop, 90s road trip, gym hype…"
              onChange={e => setVibe(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void create() }} />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Sound</label>
            <div className="flex flex-wrap gap-1.5">
              {CHIPS.map(c => (
                <ChipButton key={c} active={chips.includes(c)}
                  onClick={() => setChips(cur => cur.includes(c) ? cur.filter(x => x !== c) : [...cur, c])}>
                  {c}
                </ChipButton>
              ))}
            </div>
          </div>
          <div className="flex items-end justify-between gap-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Energy</label>
              <div className="flex gap-1.5">
                {ARCS.map(a => <ChipButton key={a.key} active={arc === a.key} onClick={() => setArc(a.key)}>{a.label}</ChipButton>)}
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Songs</label>
              <div className="flex gap-1.5">
                {[12, 20, 30].map(n => <ChipButton key={n} active={count === n} onClick={() => setCount(n)}>{n}</ChipButton>)}
              </div>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={create} disabled={!vibe.trim() || busy}>
            {busy ? <><Spinner size="sm" /> Mixing…</> : <><Sparkles className="size-4" /> Create mix</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Smart rules ───────────────────────────────────────────────────────────────────────

const FIELDS = [
  { key: 'artist', label: 'Artist', ops: [['contains', 'contains'], ['is', 'is']], input: 'text' },
  { key: 'title', label: 'Title', ops: [['contains', 'contains'], ['is', 'is']], input: 'text' },
  { key: 'genre', label: 'Genre / mood', ops: [['contains', 'contains'], ['is', 'is']], input: 'text' },
  { key: 'plays', label: 'Play count', ops: [['gte', 'at least'], ['lt', 'under']], input: 'number' },
  { key: 'lastPlayed', label: 'Last played', ops: [['before', 'over N days ago'], ['after', 'within N days']], input: 'number' },
  { key: 'favorite', label: 'Favorited', ops: [['isTrue', 'is true']], input: 'none' },
  { key: 'rating', label: 'Rating', ops: [['gte', 'at least'], ['is', 'exactly']], input: 'number' },
] as const

const emptyRule = (): SmartRule => ({ field: 'artist', op: 'contains', value: '' })

export function SmartPlaylistDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [match, setMatch] = useState<'all' | 'any'>('all')
  const [rules, setRules] = useState<SmartRule[]>([emptyRule()])
  const [count, setCount] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const rulesObj: SmartRules = { match, limit: 100, sort: 'plays', rules }

  // Live match count, debounced against the universe.
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => {
      previewSmartRules(rulesObj).then(r => setCount(r.count)).catch(() => setCount(null))
    }, 350)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, match, JSON.stringify(rules)])

  const setRule = (i: number, patch: Partial<SmartRule>) =>
    setRules(rs => rs.map((r, n) => (n === i ? { ...r, ...patch } : r)))

  const create = async () => {
    const n = name.trim()
    if (!n || busy) return
    setBusy(true)
    try {
      const { playlist } = await createSmartPlaylist({ name: n, rules: rulesObj })
      toast.success(`"${playlist.name}" created`)
      onOpenChange(false)
      navigate(`/music/playlist/${playlist.id}`)
    } catch {
      toast.error('Could not create the smart playlist')
    } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!busy) onOpenChange(v) }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Smart playlist</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <Input value={name} autoFocus placeholder="Playlist name" onChange={e => setName(e.target.value)} />
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Match</span>
            <ChipButton active={match === 'all'} onClick={() => setMatch('all')}>all rules</ChipButton>
            <ChipButton active={match === 'any'} onClick={() => setMatch('any')}>any rule</ChipButton>
          </div>
          <div className="space-y-2">
            {rules.map((r, i) => {
              const field = FIELDS.find(f => f.key === r.field) ?? FIELDS[0]
              return (
                <div key={i} className="flex items-center gap-1.5">
                  <select value={r.field}
                    onChange={e => {
                      const f = FIELDS.find(x => x.key === e.target.value) ?? FIELDS[0]
                      setRule(i, { field: f.key, op: f.ops[0]![0], value: f.input === 'number' ? 3 : '' })
                    }}
                    className="h-8 rounded-control border border-border bg-background px-2 text-sm">
                    {FIELDS.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
                  </select>
                  <select value={r.op} onChange={e => setRule(i, { op: e.target.value })}
                    className="h-8 rounded-control border border-border bg-background px-2 text-sm">
                    {field.ops.map(([op, label]) => <option key={op} value={op}>{label}</option>)}
                  </select>
                  {field.input !== 'none' && (
                    <Input value={String(r.value ?? '')} type={field.input}
                      onChange={e => setRule(i, { value: field.input === 'number' ? Number(e.target.value) : e.target.value })}
                      className="h-8 flex-1" />
                  )}
                  {rules.length > 1 && (
                    <Button variant="ghost" size="sm" onClick={() => setRules(rs => rs.filter((_, n) => n !== i))}>✕</Button>
                  )}
                </div>
              )
            })}
            <Button variant="secondary" size="sm" onClick={() => setRules(rs => [...rs, emptyRule()])}>Add rule</Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {count == null ? 'Counting…' : `${count} song${count === 1 ? '' : 's'} match right now - updates automatically as you listen.`}
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={create} disabled={!name.trim() || busy}>{busy ? <Spinner size="sm" /> : 'Create'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
