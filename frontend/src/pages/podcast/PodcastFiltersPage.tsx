import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Play, Pause, Plus, Pencil, Trash2, ListFilter, ListPlus, ListStart } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Chip, ChipRow } from '@/components/shared/ChipRow'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { EmptyAppState } from '@/components/shared/EmptyAppState'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { ShowCover } from '@/components/podcast/ShowCover'
import { usePodcastPlayback, type PodcastTrack } from '@/context/PodcastPlaybackContext'
import { getShows } from '@/lib/podcast/api'
import { fmtDate, fmtDuration } from '@/lib/podcast/format'
import { getAppByPath } from '@/lib/appCategories'
import {
  createFilter, deleteFilter, getFilterEpisodes, getFilters, updateFilter,
  type FilterEpisodeResult, type FilterRule, type FilterRules, type SavedFilter,
} from '@/lib/podcast/playerApi'

function toPlaybackTrack(e: FilterEpisodeResult): PodcastTrack {
  return {
    episodeId: e.id,
    showId: e.showId,
    showName: e.showName,
    title: e.title,
    description: e.description ?? undefined,
    durationSec: e.durationSec ?? undefined,
    coverUrl: `/api/podcasts/shows/${e.showId}/cover`,
  }
}

/** Smart episode filters: saved rule sets ("unplayed under 30 minutes from these shows")
 *  evaluated live over everything the user can play, with play-all-into-queue. */
export function PodcastFiltersPage() {
  const qc = useQueryClient()
  const { playQueue, playAllIntoQueue } = usePodcastPlayback()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<SavedFilter | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const { data: filters = [], isLoading } = useQuery({ queryKey: ['podcast-filters'], queryFn: getFilters })

  // Keep a valid selection as filters load/change.
  useEffect(() => {
    if (filters.length === 0) { setSelectedId(null); return }
    if (!selectedId || !filters.some(f => f.id === selectedId)) setSelectedId(filters[0]!.id)
  }, [filters, selectedId])

  const selected = filters.find(f => f.id === selectedId) ?? null

  const { data: episodes = [], isLoading: episodesLoading } = useQuery({
    queryKey: ['podcast-filter-episodes', selectedId],
    queryFn: () => getFilterEpisodes(selectedId!),
    enabled: !!selectedId,
  })

  const tracks = useMemo(() => episodes.map(toPlaybackTrack), [episodes])

  async function handleDelete(id: string) {
    try {
      await deleteFilter(id)
      await qc.invalidateQueries({ queryKey: ['podcast-filters'] })
      toast.success('Filter deleted.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete the filter.')
    }
  }

  return (
    <PageContainer width="wide" className="py-2 pb-24">
      <PageHeader
        title="Filters"
        subtitle="Saved smart filters over every episode you can play."
        actions={
          <Button onClick={() => { setEditing(null); setEditorOpen(true) }}>
            <Plus className="mr-1.5 size-4" /> New filter
          </Button>
        }
      />

      {isLoading ? null : filters.length === 0 ? (
        <EmptyAppState
          icon={ListFilter}
          gradient={getAppByPath('/podcasts')?.gradient}
          title="Cut your backlog down to size"
          tagline="Build rule-based filters like unplayed episodes under 30 minutes, or anything new this week from your favorite shows, then play the whole list straight into your queue."
          actions={
            <Button onClick={() => { setEditing(null); setEditorOpen(true) }}>
              <Plus className="mr-1.5 size-4" /> Create your first filter
            </Button>
          }
        />
      ) : (
        <>
          <ChipRow className="mb-5">
            {filters.map(f => (
              <Chip key={f.id} label={f.name} active={f.id === selectedId} onClick={() => setSelectedId(f.id)} />
            ))}
          </ChipRow>

          {selected && (
            <>
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <Button onClick={() => tracks.length && playAllIntoQueue(tracks)} disabled={tracks.length === 0} className="gap-2 font-semibold">
                  <Play className="size-4 fill-current" /> Play all ({episodes.length})
                </Button>
                <Button variant="outline" size="icon" onClick={() => { setEditing(selected); setEditorOpen(true) }}
                  title="Edit filter" aria-label="Edit filter" className="text-muted-foreground hover:text-foreground">
                  <Pencil className="size-4" />
                </Button>
                <Button variant="outline" size="icon" onClick={() => setConfirmDeleteId(selected.id)}
                  title="Delete filter" aria-label="Delete filter" className="text-muted-foreground hover:text-destructive">
                  <Trash2 className="size-4" />
                </Button>
              </div>

              {episodesLoading ? (
                <p className="py-10 text-center text-sm text-muted-foreground">Finding episodes…</p>
              ) : episodes.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">No episodes match this filter right now.</p>
              ) : (
                <div className="space-y-0.5">
                  {episodes.map((e, i) => (
                    <FilterEpisodeRow key={e.id} episode={e} onPlay={() => playQueue(tracks, i)} />
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}

      <FilterEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        initial={editing}
        onSaved={async (id) => {
          await qc.invalidateQueries({ queryKey: ['podcast-filters'] })
          await qc.invalidateQueries({ queryKey: ['podcast-filter-episodes'] })
          if (id) setSelectedId(id)
        }}
      />

      <ConfirmDialog
        open={confirmDeleteId !== null}
        onOpenChange={open => !open && setConfirmDeleteId(null)}
        title="Delete this filter?"
        description="The saved filter will be removed. Episodes themselves are not affected."
        confirmLabel="Delete"
        destructive
        onConfirm={() => { if (confirmDeleteId) { void handleDelete(confirmDeleteId); setConfirmDeleteId(null) } }}
      />
    </PageContainer>
  )
}

function FilterEpisodeRow({ episode, onPlay }: { episode: FilterEpisodeResult; onPlay: () => void }) {
  const { track, playing, enqueue, playNextInQueue, pause, resume } = usePodcastPlayback()
  const isCurrent = track?.episodeId === episode.id
  const pct = episode.watchState && episode.durationSec
    ? Math.min(100, (episode.watchState.positionSec / episode.durationSec) * 100) : 0

  return (
    <div className={cn('group flex items-center gap-3 rounded-control px-3 py-2.5 transition-colors hover:bg-accent/40', isCurrent && 'bg-accent/40')}>
      <button onClick={() => isCurrent ? (playing ? pause() : resume()) : onPlay()} className="relative flex size-10 shrink-0 items-center justify-center">
        <ShowCover showId={episode.showId} title={episode.showName} size={40} rounded="rounded-control" />
        <span className={cn('absolute inset-0 flex items-center justify-center rounded-control bg-black/45 text-white transition-opacity',
          isCurrent ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}>
          {isCurrent && playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current" />}
        </span>
      </button>

      <div className="min-w-0 flex-1">
        <p className={cn('truncate text-sm font-semibold', isCurrent && 'text-brand')}>{episode.title}</p>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate">{episode.showName}</span>
          {(episode.publishedAt ?? episode.generatedAt) && <span>· {fmtDate(episode.publishedAt ?? episode.generatedAt)}</span>}
          {episode.durationSec ? <span>· {fmtDuration(episode.durationSec)}</span> : null}
          {episode.download?.status === 'ready' && <span className="text-brand">· Downloaded</span>}
        </div>
        {pct > 0 && !episode.watchState?.completed && (
          <div className="mt-1.5 h-1 w-full max-w-48 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => playNextInQueue(toPlaybackTrack(episode))}
          title="Play next" aria-label="Play next" className="size-8 text-muted-foreground hover:text-foreground">
          <ListStart className="size-4" />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => enqueue(toPlaybackTrack(episode))}
          title="Add to queue" aria-label="Add to queue" className="size-8 text-muted-foreground hover:text-foreground">
          <ListPlus className="size-4" />
        </Button>
      </div>
    </div>
  )
}

// ── Filter editor ────────────────────────────────────────────────────────────────────

interface EditorForm {
  name: string
  match: 'all' | 'any'
  unplayed: boolean
  inProgress: boolean
  downloaded: boolean
  durationOp: 'none' | 'lt' | 'gt'
  durationMin: number
  releasedDays: number
  showIds: string[]
}

const EMPTY_FORM: EditorForm = {
  name: '', match: 'all', unplayed: false, inProgress: false, downloaded: false,
  durationOp: 'none', durationMin: 30, releasedDays: 0, showIds: [],
}

function rulesToForm(f: SavedFilter): EditorForm {
  const form: EditorForm = { ...EMPTY_FORM, name: f.name, match: f.rules.match, showIds: [] }
  for (const r of f.rules.rules) {
    if (r.field === 'unplayed') form.unplayed = true
    if (r.field === 'inProgress') form.inProgress = true
    if (r.field === 'downloaded') form.downloaded = true
    if (r.field === 'duration') {
      form.durationOp = r.op === 'lt' ? 'lt' : 'gt'
      form.durationMin = Number(r.value) || 30
    }
    if (r.field === 'releasedWithin') form.releasedDays = Number(r.value) || 0
    if (r.field === 'show' && Array.isArray(r.value)) form.showIds = r.value
  }
  return form
}

function formToRules(form: EditorForm): FilterRules {
  const rules: FilterRule[] = []
  if (form.unplayed) rules.push({ field: 'unplayed' })
  if (form.inProgress) rules.push({ field: 'inProgress' })
  if (form.downloaded) rules.push({ field: 'downloaded' })
  if (form.durationOp !== 'none' && form.durationMin > 0) rules.push({ field: 'duration', op: form.durationOp, value: form.durationMin })
  if (form.releasedDays > 0) rules.push({ field: 'releasedWithin', value: form.releasedDays })
  if (form.showIds.length > 0) rules.push({ field: 'show', op: 'in', value: form.showIds })
  return { match: form.match, rules }
}

function FilterEditorDialog({ open, onOpenChange, initial, onSaved }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initial: SavedFilter | null
  onSaved: (id: string | null) => Promise<void>
}) {
  const [form, setForm] = useState<EditorForm>({ ...EMPTY_FORM })
  const [saving, setSaving] = useState(false)
  const { data: shows = [] } = useQuery({ queryKey: ['podcast-shows'], queryFn: getShows, enabled: open })

  useEffect(() => {
    if (open) setForm(initial ? rulesToForm(initial) : { ...EMPTY_FORM })
  }, [open, initial])

  const set = <K extends keyof EditorForm>(key: K, value: EditorForm[K]) => setForm(f => ({ ...f, [key]: value }))

  async function handleSave() {
    const name = form.name.trim()
    if (!name) { toast.error('Give the filter a name.'); return }
    setSaving(true)
    try {
      if (initial) {
        await updateFilter(initial.id, name, formToRules(form))
        await onSaved(initial.id)
      } else {
        const created = await createFilter(name, formToRules(form))
        await onSaved(created.id)
      }
      toast.success('Filter saved.')
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the filter.')
    } finally {
      setSaving(false)
    }
  }

  const statusToggle = (label: string, key: 'unplayed' | 'inProgress' | 'downloaded') => (
    <Chip label={label} active={form[key]} onClick={() => set(key, !form[key])} />
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>{initial ? 'Edit filter' : 'New filter'}</DialogTitle></DialogHeader>

        <div className="space-y-5">
          <div>
            <p className="mb-1.5 text-sm font-semibold">Name</p>
            <Input value={form.name} onChange={e => set('name', e.target.value)} placeholder="Quick listens" />
          </div>

          <div>
            <p className="mb-2 text-sm font-semibold">Match</p>
            <ChipRow>
              <Chip label="All rules" active={form.match === 'all'} onClick={() => set('match', 'all')} />
              <Chip label="Any rule" active={form.match === 'any'} onClick={() => set('match', 'any')} />
            </ChipRow>
          </div>

          <div>
            <p className="mb-2 text-sm font-semibold">Status</p>
            <ChipRow>
              {statusToggle('Unplayed', 'unplayed')}
              {statusToggle('In progress', 'inProgress')}
              {statusToggle('Downloaded', 'downloaded')}
            </ChipRow>
          </div>

          <div>
            <p className="mb-2 text-sm font-semibold">Duration</p>
            <div className="flex items-center gap-2">
              <ChipRow>
                <Chip label="Any" active={form.durationOp === 'none'} onClick={() => set('durationOp', 'none')} />
                <Chip label="Under" active={form.durationOp === 'lt'} onClick={() => set('durationOp', 'lt')} />
                <Chip label="Over" active={form.durationOp === 'gt'} onClick={() => set('durationOp', 'gt')} />
              </ChipRow>
              {form.durationOp !== 'none' && (
                <div className="flex items-center gap-1.5">
                  <Input type="number" min={1} max={600} value={form.durationMin || ''}
                    onChange={e => set('durationMin', Math.max(0, Math.min(600, Math.round(Number(e.target.value) || 0))))}
                    className="w-20 text-right" />
                  <span className="text-xs text-muted-foreground">min</span>
                </div>
              )}
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-sm font-semibold">Released within</p>
            <div className="flex items-center gap-1.5">
              <Input type="number" min={0} max={365} value={form.releasedDays || ''}
                onChange={e => set('releasedDays', Math.max(0, Math.min(365, Math.round(Number(e.target.value) || 0))))}
                placeholder="0" className="w-20 text-right" />
              <span className="text-xs text-muted-foreground">days (0 = any time)</span>
            </div>
          </div>

          <div>
            <p className="mb-2 text-sm font-semibold">Shows</p>
            <p className="mb-2 text-xs text-muted-foreground">Leave empty to match every show.</p>
            <div className="flex flex-wrap gap-2">
              {shows.map(s => (
                <Chip key={s.id} label={s.name}
                  active={form.showIds.includes(s.id)}
                  onClick={() => set('showIds', form.showIds.includes(s.id)
                    ? form.showIds.filter(id => id !== s.id)
                    : [...form.showIds, s.id])} />
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => void handleSave()} disabled={saving}>Save filter</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
