import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  X, Plus, Minus, Globe, RefreshCw, BookOpen, Users, Mic, BarChart2, Sparkles, Trash2, Lock,
  type LucideIcon,
} from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { usePodcastPlayback } from '@/context/PodcastPlaybackContext'
import { CoverPicker } from '@/components/podcast/CoverPicker'
import { StingerPicker } from '@/components/podcast/StingerPicker'
import {
  createShow, updateShow, deleteShow, saveCover, saveStinger, getHostCharacters, generateShowDescription,
  type Show, type PodcastStyle, type ShowSegment, type ShowHost,
} from '@/lib/podcast/api'
import type { StingerSelection } from '@/lib/podcast/stinger'
import { createPodcast, getChannelPage, getPlaylist, ytImageProxy } from '@/lib/youtube/api'
import { thumbUrl } from '@/lib/youtube/format'
import { getBatchSize, setBatchSize, MAX_BATCH } from '@/lib/youtube/podcast'

/** Optional YouTube source: tag the new show + generate a first batch of episodes. */
export interface YoutubeShowSource {
  videos: { videoId: string; title?: string; author?: string; source?: string; url?: string }[]
  sourceRef: string
  /** Source photo (channel avatar / thumbnail), already proxied — used in ~half the covers. */
  coverImageUrl?: string
  /** Channel/playlist name (raw, no "Podcast" suffix) — used in the auto-description. */
  sourceName?: string
  /** Channel/playlist "about" text — woven into the auto-description. */
  sourceDescription?: string
}

// Spoken-word minutes per style (165 words/min). Mirrors STYLE_INSTRUCTIONS in script.ts.
const STYLE_DEFAULT_MINUTES: Record<PodcastStyle, number> = {
  recap: 7, 'in-depth': 12, roundtable: 11, interview: 11, briefing: 6, story: 9,
}
const MIN_EP_MINUTES = 3
const MAX_EP_MINUTES = 30

const STYLES: { id: PodcastStyle; label: string; icon: LucideIcon }[] = [
  { id: 'recap', label: 'Recap', icon: RefreshCw },
  { id: 'in-depth', label: 'In-Depth', icon: BookOpen },
  { id: 'roundtable', label: 'Roundtable', icon: Users },
  { id: 'interview', label: 'Interview', icon: Mic },
  { id: 'briefing', label: 'Briefing', icon: BarChart2 },
  { id: 'story', label: 'Story', icon: Sparkles },
]

const SEGMENT_TYPES = ['youtube', 'news', 'sports', 'weather', 'onThisDay', 'bookmarks', 'custom']

// Auto-description building blocks.
const STYLE_VERB: Record<PodcastStyle, string> = {
  recap: 'recap', 'in-depth': 'take a deep dive into', roundtable: 'dig into',
  interview: 'talk through', briefing: 'break down', story: 'tell the story of',
}
// An engaging closing line per format (used for source-based shows).
const STYLE_CLOSER: Record<PodcastStyle, string> = {
  recap: 'Each episode recaps a new video with sharp takes and real conversation.',
  'in-depth': 'Each episode unpacks a video in depth: the context, the nuance, the bigger picture.',
  roundtable: 'Every episode is a lively roundtable on a fresh upload.',
  interview: 'Each episode digs into a video, interview-style.',
  briefing: 'Each episode is a tight, no-fluff briefing on the latest drop.',
  story: 'Each episode turns a video into a story worth hearing.',
}
const SEGMENT_TOPIC: Record<string, string> = {
  youtube: 'the latest from your subscriptions', news: 'the day’s news', sports: 'sports',
  weather: 'the weather', onThisDay: 'this day in history', custom: 'hand-picked topics',
  bookmarks: 'the articles you saved this week',
}
function joinNames(list: string[]): string {
  if (list.length <= 1) return list[0] ?? ''
  if (list.length === 2) return `${list[0]} and ${list[1]}`
  return `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`
}
/** A clean 1–2 sentence snippet from a channel's "about" text (strips URLs, caps length). */
function descSnippet(text: string | undefined | null, max = 220): string {
  if (!text) return ''
  const clean = text.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  let out = ''
  for (const s of clean.split(/(?<=[.!?])\s+/)) {
    if (out && (`${out} ${s}`).length > max) break
    out = out ? `${out} ${s}` : s
    if (out.length >= max) break
  }
  if (out.length > max) out = out.slice(0, max).replace(/\s+\S*$/, '').trim() + '…'
  return out
}

export function ShowEditorDialog({ open, onClose, initial, youtube, presetName }: {
  open: boolean
  onClose: () => void
  initial?: Show | null
  /** When launched from a YouTube source: tag the new show + generate a first batch. */
  youtube?: YoutubeShowSource
  /** Suggested title when creating (e.g. the channel name). */
  presetName?: string
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { closeIfShow } = usePodcastPlayback()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [style, setStyle] = useState<PodcastStyle>('recap')
  const [segments, setSegments] = useState<ShowSegment[]>([{ type: 'news' }])
  const [hosts, setHosts] = useState<ShowHost[]>([])
  const [visibility, setVisibility] = useState<'personal' | 'shared'>('personal')
  const [coverBlob, setCoverBlob] = useState<Blob | null>(null)
  const [stinger, setStinger] = useState<StingerSelection | null>(null)
  const [targetMinutes, setTargetMinutes] = useState<number | null>(null)
  const [genningDesc, setGenningDesc] = useState(false)
  const [batch, setBatch] = useState(getBatchSize())
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const { data: characters = [] } = useQuery({ queryKey: ['host-characters'], queryFn: getHostCharacters })
  // YouTube generation only applies when creating a brand-new show from a source.
  const ytCreate = !!youtube && !initial?.id
  const ytMulti = (youtube?.videos.length ?? 0) > 1

  // When EDITING a YouTube-sourced show, reconstruct the cover source image (channel
  // avatar / first video thumb) from the show's sourceRef, so cover previews composite
  // the channel art exactly like creation does — not just blank gradients.
  const editYtRef = (() => {
    if (ytCreate || !initial?.sourceRef) return null
    const m = initial.sourceRef.match(/^(channel|playlist):(.+)$/)
    return m ? { kind: m[1] as 'channel' | 'playlist', id: m[2]! } : null
  })()
  const { data: editCoverImageUrl } = useQuery({
    queryKey: ['podcast-edit-cover', editYtRef?.kind, editYtRef?.id],
    enabled: open && !!editYtRef,
    staleTime: 60 * 60 * 1000,
    queryFn: async () => {
      if (!editYtRef) return undefined
      if (editYtRef.kind === 'channel') {
        const page = await getChannelPage(editYtRef.id)
        const raw = page.meta?.thumbnailUrl ?? page.videos[0]?.channelThumb ?? page.videos[0]?.thumbnailUrl ?? null
        return raw ? ytImageProxy(raw) : undefined
      }
      const v0 = (await getPlaylist(editYtRef.id)).videos[0]
      return v0 ? ytImageProxy(thumbUrl(v0.videoId, 'hq')) : undefined
    },
  })

  useEffect(() => {
    if (!open) return
    setName(initial?.name ?? presetName ?? '')
    setDescription(initial?.description ?? '')
    setStyle(initial?.style ?? 'recap')
    setSegments(initial?.segments?.length ? initial.segments : [{ type: youtube ? 'youtube' : 'news' }])
    setHosts(initial?.hosts ?? [])
    setVisibility(initial?.visibility ?? 'personal')
    setTargetMinutes(initial?.targetMinutes ?? null)
    setCoverBlob(null)
    setStinger(null)
    setBatch(getBatchSize())
    // Reset only when the dialog opens or switches to a different show — NOT on every
    // render. `youtube`/`initial`/`presetName` are fresh object literals from the parent
    // each render; depending on them re-ran this effect and wiped the user's picked
    // cover/stinger mid-session (so neither got saved). Stable primitives only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial?.id])

  function changeBatch(n: number) {
    const clamped = Math.min(MAX_BATCH, Math.max(1, n))
    setBatch(clamped); setBatchSize(clamped)
  }

  function toggleHost(id: string) {
    setHosts(prev => {
      if (prev.some(h => h.characterId === id)) return prev.filter(h => h.characterId !== id)
      return [...prev, { characterId: id, role: prev.length === 0 ? 'host' : 'co-host' }]
    })
  }

  // Compose an engaging, specific description from the selection (hosts + the actual
  // source + its own "about" text + format). For a channel:
  //   "Loki, Sage, and Juniper dig into Mo Bitar’s channel. Exploring what AI actually
  //    is… Every episode is a lively roundtable on a fresh upload."
  function buildDescription(): string {
    const hostNames = hosts
      .map(h => characters.find(c => c.id === h.characterId)?.name)
      .filter((n): n is string => !!n)
    const who = joinNames(hostNames) || 'Your AI hosts'
    const verb = STYLE_VERB[style] ?? 'dig into'

    if (ytCreate) {
      const srcName = (youtube?.sourceName || youtube?.videos[0]?.author || name).trim() || 'this channel'
      const isPlaylist = youtube?.sourceRef?.startsWith('playlist:')
      const item = isPlaylist ? `the “${srcName}” playlist` : `${srcName}’s channel`
      const snip = descSnippet(youtube?.sourceDescription)
      const lead = `${who} ${verb} ${item}.`
      return [lead, snip, STYLE_CLOSER[style]].filter(Boolean).join(' ')
    }

    const topics = joinNames([...new Set(segments.map(s => SEGMENT_TOPIC[s.type] ?? s.type))])
    return `${who} ${verb} ${topics || 'a mix of topics'}, with fresh takes and real conversation in every episode.`
  }

  // LLM-written description (varied + rich, fed the real source/about/topics). Falls
  // back to the local template when the model is unavailable (offline / not installed).
  async function generateDescription(): Promise<string> {
    const hostNames = hosts
      .map(h => characters.find(c => c.id === h.characterId)?.name)
      .filter((n): n is string => !!n)
    const sampleTitles = ytCreate
      ? (youtube?.videos.map(v => v.title).filter((t): t is string => !!t) ?? [])
      : [...new Set(segments.map(s => SEGMENT_TOPIC[s.type] ?? s.type))]
    try {
      return await generateShowDescription({
        hosts: hostNames,
        showName: name.trim() || undefined,
        sourceName: ytCreate ? (youtube?.sourceName || youtube?.videos[0]?.author || undefined) : undefined,
        sourceKind: ytCreate ? (youtube?.sourceRef?.startsWith('playlist:') ? 'playlist' : 'channel') : undefined,
        sourceDescription: ytCreate ? youtube?.sourceDescription : undefined,
        style,
        sampleTitles,
      })
    } catch {
      return buildDescription()
    }
  }

  async function handleSave() {
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      // Auto-write the description from the selection when the user left it blank.
      const finalDesc = description.trim() || await generateDescription()
      const input = { name: name.trim(), description: finalDesc || null, style, segments, hosts, visibility, sourceRef: ytCreate ? youtube!.sourceRef : undefined, targetMinutes }
      const show = initial?.id
        ? (await updateShow(initial.id, input), { id: initial.id } as Show)
        : await createShow(input)
      if (coverBlob && show?.id) {
        try { await saveCover(show.id, coverBlob) } catch { /* non-fatal */ }
      }
      if (stinger && show?.id) {
        try { await saveStinger(show.id, stinger.introBlob, stinger.outroBlob) } catch { /* non-fatal */ }
      }
      // YouTube: generate the first batch of episodes (one per video, newest first).
      if (ytCreate && show?.id) {
        const res = await createPodcast(youtube!.videos.slice(0, 100), { showId: show.id, limit: batch })
        if (res.error) toast.error(res.error)
        else {
          const n = res.episodeCount ?? 0
          toast.success(`Podcast created — ${n} ${n === 1 ? 'episode' : 'episodes'} generating, newest first${res.remaining ? ` · ${res.remaining} left` : ''}.`)
        }
      }
      await qc.invalidateQueries({ queryKey: ['podcast-shows'] })
      onClose()
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!initial?.id) return
    setSaving(true)
    try {
      await deleteShow(initial.id)
      closeIfShow(initial.id)
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['podcast-shows'] }),
        qc.invalidateQueries({ queryKey: ['podcast-feed'] }),
      ])
      onClose()
      navigate('/podcasts/library')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-h-[88vh] max-w-3xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border/40 px-5 py-4">
          <DialogTitle>{initial?.id ? 'Edit Show' : 'Create a New Show'}</DialogTitle>
          <DialogDescription className="sr-only">Configure this podcast show's details.</DialogDescription>
        </DialogHeader>

        <div className="grid max-h-[calc(88vh-9rem)] grid-cols-1 gap-6 overflow-y-auto p-5 md:grid-cols-2">
          {/* Left: details */}
          <div className="space-y-4">
            <Field label="Show Title">
              <input value={name} onChange={e => setName(e.target.value)} maxLength={100}
                placeholder="Reel Talk Reviews"
                className="w-full rounded-control border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand" />
            </Field>

            <Field label="Show Description">
              <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} maxLength={500}
                placeholder="What is your show about? (leave blank to auto-generate)"
                className="w-full resize-none rounded-control border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand" />
              <button type="button" disabled={genningDesc}
                onClick={async () => { setGenningDesc(true); try { setDescription(await generateDescription()) } finally { setGenningDesc(false) } }}
                className="mt-1.5 flex items-center gap-1 text-xs font-medium text-brand hover:underline disabled:opacity-50">
                {genningDesc ? <Spinner size="sm" className="size-3 text-current" /> : <Sparkles className="size-3" />}
                {genningDesc ? 'Writing…' : 'Generate from selection'}
              </button>
            </Field>

            <Field label="Format">
              <div className="grid grid-cols-3 gap-1.5">
                {STYLES.map(s => {
                  const Icon = s.icon
                  return (
                    <button key={s.id} type="button" onClick={() => setStyle(s.id)}
                      className={cn('flex items-center gap-1.5 rounded-control border px-2 py-1.5 text-xs font-medium transition-colors',
                        style === s.id ? 'border-brand bg-brand/10 text-brand' : 'border-border hover:bg-muted')}>
                      <Icon className="size-3.5" /> {s.label}
                    </button>
                  )
                })}
              </div>
            </Field>

            <Field label="Episode Length">
              {(() => {
                const styleDefault = STYLE_DEFAULT_MINUTES[style] ?? 7
                const display = targetMinutes ?? styleDefault
                const isCustom = targetMinutes !== null
                return (
                  <div className="flex items-center justify-between rounded-control border border-border px-3 py-2">
                    <div className="flex flex-col">
                      <span className="text-sm font-semibold tabular-nums">{display} min</span>
                      {isCustom ? (
                        <button type="button" onClick={() => setTargetMinutes(null)}
                          className="mt-0.5 text-left text-xs text-muted-foreground hover:text-foreground">
                          Reset to style default ({styleDefault} min)
                        </button>
                      ) : (
                        <span className="mt-0.5 text-xs text-muted-foreground">Style default</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <StepBtn icon={Minus} disabled={display <= MIN_EP_MINUTES}
                        onClick={() => setTargetMinutes(Math.max(MIN_EP_MINUTES, display - 1))} />
                      <StepBtn icon={Plus} disabled={display >= MAX_EP_MINUTES}
                        onClick={() => setTargetMinutes(Math.min(MAX_EP_MINUTES, display + 1))} />
                    </div>
                  </div>
                )
              })()}
            </Field>

            {ytCreate && ytMulti && (
              <Field label="Episodes this batch">
                <div className="flex items-center justify-between rounded-control border border-border px-3 py-2">
                  <span className="text-xs text-muted-foreground">Newest first · up to {MAX_BATCH}. Generate more later.</span>
                  <div className="flex items-center gap-1">
                    <StepBtn icon={Minus} disabled={batch <= 1} onClick={() => changeBatch(batch - 1)} />
                    <span className="w-7 text-center text-sm font-bold tabular-nums">{Math.min(batch, youtube!.videos.length)}</span>
                    <StepBtn icon={Plus} disabled={batch >= MAX_BATCH || batch >= youtube!.videos.length} onClick={() => changeBatch(batch + 1)} />
                  </div>
                </div>
              </Field>
            )}

            <Field label="Content Sources">
              {ytCreate ? (
                // Locked for YouTube-created shows: the source IS this channel/playlist.
                // Editing it here would only affect later "New episode" generations from
                // the Podcasts page and produce off-topic content, so it's fixed.
                <div className="flex items-center gap-2 rounded-control border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                  <Lock className="size-3.5 shrink-0" />
                  <span>Sourced from this YouTube {youtube!.sourceRef?.startsWith('playlist:') ? 'playlist' : 'channel'}</span>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {segments.map((seg, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <select value={seg.type}
                        onChange={e => setSegments(prev => prev.map((s, j) => j === i ? { ...s, type: e.target.value } : s))}
                        className="flex-1 rounded-control border border-border bg-background px-2 py-1.5 text-sm outline-none">
                        {SEGMENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <button type="button" onClick={() => setSegments(prev => prev.filter((_, j) => j !== i))}
                        className="text-muted-foreground hover:text-destructive"><X className="size-3.5" /></button>
                    </div>
                  ))}
                  <button type="button" onClick={() => setSegments(prev => [...prev, { type: 'news' }])}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                    <Plus className="size-3" /> Add source
                  </button>
                </div>
              )}
            </Field>

            {characters.length > 0 && (
              <Field label="Hosts">
                <div className="flex flex-wrap gap-1.5">
                  {characters.map(ch => {
                    const on = hosts.some(h => h.characterId === ch.id)
                    return (
                      <button key={ch.id} type="button" onClick={() => toggleHost(ch.id)}
                        className={cn('rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                          on ? 'border-brand bg-brand/10 text-brand' : 'border-border text-muted-foreground hover:bg-muted')}>
                        {ch.name}
                      </button>
                    )
                  })}
                </div>
              </Field>
            )}

            <button type="button" onClick={() => setVisibility(v => v === 'personal' ? 'shared' : 'personal')}
              className={cn('flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors',
                visibility === 'shared' ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground hover:bg-muted/80')}>
              <Globe className="size-3.5" /> {visibility === 'shared' ? 'Shared with family' : 'Private'}
            </button>
          </div>

          {/* Right: cover + stinger */}
          <div className="space-y-5">
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">Show Cover</p>
              <CoverPicker title={name || 'New Show'} topicText={description} imageUrl={ytCreate ? youtube!.coverImageUrl : editCoverImageUrl} onChange={blob => setCoverBlob(blob)} />
            </div>
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">Intro / Outro Music</p>
              <StingerPicker onChange={setStinger} autoSelect={!initial?.id} />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/40 px-5 py-3">
          {initial?.id && (
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)} disabled={saving}
              className="mr-auto text-destructive hover:bg-destructive/10 hover:text-destructive">
              <Trash2 className="size-3.5" /> Delete Show
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={handleSave} disabled={!name.trim() || saving}>
            {saving && <Spinner size="sm" className="text-current" />}
            {initial?.id ? 'Save Changes' : ytCreate ? 'Create podcast' : 'Create Show'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>

    <ConfirmDialog
      open={confirmDelete}
      onOpenChange={setConfirmDelete}
      title="Delete show"
      description={`Delete "${initial?.name ?? 'this show'}" and all its episodes? This cannot be undone.`}
      confirmLabel="Delete"
      destructive
      onConfirm={() => void handleDelete()}
    />
    </>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}

function StepBtn({ icon: Icon, disabled, onClick }: { icon: LucideIcon; disabled?: boolean; onClick: () => void }) {
  return (
    <Button type="button" variant="outline" size="icon-sm" onClick={onClick} disabled={disabled}
      className="border-border text-foreground disabled:cursor-not-allowed">
      <Icon className="size-3.5" />
    </Button>
  )
}
