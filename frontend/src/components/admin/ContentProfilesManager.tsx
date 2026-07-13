import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus, Trash2, Star, ShieldAlert, ChevronRight, ChevronLeft, Check, Baby } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Spinner } from '@/components/ui/spinner'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { ContentDialGroup, MIN_DIALS, normalizeDials, CONTENT_DIALS } from '@/components/shared/contentDials'
import type { ContentDialValues, DialKey } from '@/components/shared/contentDials'
import { toast } from '@/lib/toast'

// Admin content profiles — named sets of per-category ceilings assigned to users.
// Master-detail: a list of profiles (name + description), edit one at a time to see
// all the toggles. Every category tops out at "unrestricted"; the two absolute
// limits (minors, mass-casualty weapons) always apply and aren't shown as dials.

interface Profile {
  slug: string
  name: string
  description: string
  dials: ContentDialValues
  isBuiltin: boolean
  sortOrder: number
  kidSafeMedia: boolean
}

const opts: RequestInit = { credentials: 'include' }
const J = { 'Content-Type': 'application/json' }

function openLabels(dials: ContentDialValues): string[] {
  return CONTENT_DIALS.filter((d) => dials[d.key] === 'unrestricted').map((d) => d.label)
}
function summarize(dials: ContentDialValues): string {
  const open = openLabels(dials).length
  const off = CONTENT_DIALS.filter((d) => dials[d.key] === 'off').length
  if (off === CONTENT_DIALS.length) return 'All restricted'
  if (open === CONTENT_DIALS.length) return 'Fully unrestricted'
  return `${open} unrestricted · ${CONTENT_DIALS.length - off} active`
}

export function ContentProfilesManager({ embedded = false }: { embedded?: boolean } = {}) {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [defaultSlug, setDefaultSlug] = useState<string>('locked')
  const [loading, setLoading] = useState(true)
  const [editingSlug, setEditingSlug] = useState<string | null>(null)
  const [draft, setDraft] = useState<Profile | null>(null)
  const [saving, setSaving] = useState(false)
  const [delTarget, setDelTarget] = useState<Profile | null>(null)
  const draftRef = useRef<Profile | null>(null)
  draftRef.current = draft

  const load = useCallback((selectSlug?: string) => {
    setLoading(true)
    fetch('/api/admin/content/profiles', opts)
      .then((r) => r.ok ? r.json() : null)
      .then((d: { profiles: Profile[]; defaultSlug: string } | null) => {
        if (!d) return
        const norm = d.profiles.map((p) => ({ ...p, dials: normalizeDials(p.dials, MIN_DIALS) }))
        setProfiles(norm)
        setDefaultSlug(d.defaultSlug)
        if (selectSlug) { const p = norm.find((x) => x.slug === selectSlug); if (p) { setDraft({ ...p }); setEditingSlug(p.slug) } }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => { load() }, [load])

  const openEditor = (p: Profile) => { setDraft({ ...p }); setEditingSlug(p.slug) }
  const closeEditor = () => { setEditingSlug(null); setDraft(null); load() }

  const saveDraft = async (p: Profile) => {
    setSaving(true)
    try {
      const r = await fetch(`/api/admin/content/profiles/${p.slug}`, {
        ...opts, method: 'PUT', headers: J,
        body: JSON.stringify({ name: p.name, description: p.description, dials: p.dials, kidSafeMedia: p.kidSafeMedia }),
      })
      if (!r.ok) throw new Error()
    } catch { toast.error('Failed to save') } finally { setSaving(false) }
  }

  const setDial = (k: DialKey, v: string) => {
    if (!draft) return
    const next = { ...draft, dials: { ...draft.dials, [k]: v } }
    setDraft(next)
    void saveDraft(next)
  }

  const setKidSafe = (on: boolean) => {
    if (!draft) return
    const next = { ...draft, kidSafeMedia: on }
    setDraft(next)
    void saveDraft(next)
  }

  const makeDefault = async (slug: string) => {
    const r = await fetch('/api/admin/content/default-profile', { ...opts, method: 'PUT', headers: J, body: JSON.stringify({ slug }) })
    if (r.ok) { setDefaultSlug(slug); toast.success('Default profile updated') } else toast.error('Failed')
  }

  const create = async () => {
    const r = await fetch('/api/admin/content/profiles', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ name: 'New profile', dials: MIN_DIALS }) })
    if (!r.ok) { toast.error('Failed to create profile'); return }
    const { profile } = await r.json() as { profile: Profile }
    load(profile.slug)
  }

  const doDelete = async () => {
    if (!delTarget) return
    const r = await fetch(`/api/admin/content/profiles/${delTarget.slug}`, { ...opts, method: 'DELETE' })
    const body = await r.json().catch(() => ({})) as { error?: string }
    if (r.ok) { toast.success('Profile deleted'); if (editingSlug === delTarget.slug) closeEditor(); load() } else toast.error(body.error ?? 'Failed to delete')
    setDelTarget(null)
  }

  if (loading) return <div className="flex items-center justify-center h-32"><Spinner className="size-5" /></div>

  // ── Editor (one profile) ────────────────────────────────────────────────────
  if (editingSlug && draft) {
    const open100 = openLabels(draft.dials)
    const isDefault = defaultSlug === draft.slug
    return (
      <Card>
        {/* Header — back nav + profile identity + actions all in one bar */}
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
          <Button variant="ghost" size="sm" onClick={closeEditor}
            className="gap-1 px-2 text-muted-foreground hover:text-foreground shrink-0">
            <ChevronLeft className="size-4" /> Profiles
          </Button>
          <ChevronRight className="size-3.5 text-muted-foreground/40 shrink-0" />
          <span className="min-w-0 truncate text-sm font-semibold">{draft.name || 'New profile'}</span>
          {draft.isBuiltin && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground shrink-0">built-in</span>}
          {isDefault && <span className="rounded-full bg-brand/15 px-2 py-0.5 text-[10px] font-medium text-brand shrink-0">default</span>}
          <div className="flex-1" />
          {saving && <Spinner size="sm" className="shrink-0" />}
          {!isDefault && (
            <Button variant="outline" size="sm" onClick={() => void makeDefault(draft.slug)}
              className="gap-1.5 text-muted-foreground hover:text-foreground shrink-0">
              <Star className="size-3.5" /> Make default
            </Button>
          )}
          {!draft.isBuiltin && (
            <Button variant="ghost" size="icon-sm" onClick={() => setDelTarget(draft)} aria-label="Delete profile"
              className="text-muted-foreground hover:text-destructive shrink-0">
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>

        <div className="p-5 space-y-4">
          {/* Name + description */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Name</label>
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                onBlur={() => { if (draftRef.current) void saveDraft(draftRef.current) }}
                disabled={draft.isBuiltin}
                placeholder="Profile name"
                className="h-9"
              />
              {draft.isBuiltin && <p className="text-[11px] text-muted-foreground">Built-in name can't be changed.</p>}
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Description</label>
              <Input
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                onBlur={() => { if (draftRef.current) void saveDraft(draftRef.current) }}
                placeholder="What this profile is for"
                className="h-9"
              />
            </div>
          </div>

          {/* Kid-Safe Media: one master switch for music/videos/podcasts. When on, all three
              lock to the strictest tier (explicit blocked, mature topics filtered, unrated
              content hidden, YouTube Restricted Mode) regardless of the dials below. */}
          <div className="flex items-start gap-3 rounded-card border border-border/60 bg-muted/30 px-3 py-3">
            <Baby className="size-4 shrink-0 text-brand mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="kid-safe-media" className="text-sm font-medium">Kid-Safe Media</label>
                <Switch id="kid-safe-media" checked={draft.kidSafeMedia} onCheckedChange={setKidSafe} />
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Filters music, videos, and podcasts for young children: blocks explicit lyrics and mature topics (drugs, sex, violence), hides anything not verified safe, and turns on YouTube Restricted Mode. Leave off to derive protection from the dials below.
              </p>
            </div>
          </div>

          {/* Category limits */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Category limits</p>
              <p className="text-xs text-muted-foreground">off → unrestricted</p>
            </div>
            <ContentDialGroup values={draft.dials} onDial={setDial} />
          </div>

          {open100.length > 0 && (
            <div className="flex items-start gap-2 rounded-card border border-warning/20 bg-warning/10 px-3 py-2">
              <ShieldAlert className="size-3.5 text-warning mt-0.5 shrink-0" />
              <p className="text-xs text-warning">
                Unrestricted: {open100.join(', ')}. No limit on these topics (sexual content involving minors &amp; mass-casualty weapons always blocked).
              </p>
            </div>
          )}
        </div>

        <ConfirmDialog open={!!delTarget} onOpenChange={(o) => { if (!o) setDelTarget(null) }}
          title={`Delete "${delTarget?.name}"?`} description="Users on this profile will be reassigned to the default profile."
          confirmLabel="Delete" destructive onConfirm={() => void doDelete()} />
      </Card>
    )
  }

  // ── List (master) ───────────────────────────────────────────────────────────
  return (
    <div>
      <div className="mb-4 flex items-end justify-between gap-3">
        {!embedded ? (
          <div>
            <h2 className="text-section">Content Profiles</h2>
            <p className="text-sm text-muted-foreground">Named per-category ceilings assigned to users. New accounts get the default; a companion can never exceed the user's profile.</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Pick a profile to edit its category limits.</p>
        )}
        <Button size="sm" onClick={() => void create()} className="shrink-0 gap-1.5">
          <Plus className="size-3.5" /> New profile
        </Button>
      </div>

      <Card className="divide-y divide-border/40">
        {profiles.map((p) => (
          <button key={p.slug} onClick={() => openEditor(p)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium">{p.name}</span>
                {defaultSlug === p.slug && <span className="rounded-full bg-brand/15 px-1.5 py-0.5 text-[10px] font-medium text-brand">default</span>}
                {p.isBuiltin && <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">built-in</span>}
              </div>
              {p.description && <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">{p.description}</p>}
            </div>
            <span className="shrink-0 rounded-full bg-muted/60 px-2 py-0.5 text-[11px] text-muted-foreground">{summarize(p.dials)}</span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </button>
        ))}
      </Card>
      <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground"><Check className="size-3" /> Assign profiles to users in the Accounts section above.</p>
    </div>
  )
}
