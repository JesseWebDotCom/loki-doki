import { useCallback, useEffect, useState } from 'react'
import { Plus, Trash2, Save, Star, Loader2, ShieldAlert, ChevronRight, ChevronLeft, Check } from 'lucide-react'
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
  const [editingSlug, setEditingSlug] = useState<string | null>(null)  // null = list view
  const [draft, setDraft] = useState<Profile | null>(null)
  const [saving, setSaving] = useState(false)
  const [delTarget, setDelTarget] = useState<Profile | null>(null)

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
  const closeEditor = () => { setEditingSlug(null); setDraft(null) }

  const save = async () => {
    if (!draft) return
    setSaving(true)
    try {
      const r = await fetch(`/api/admin/content/profiles/${draft.slug}`, {
        ...opts, method: 'PUT', headers: J,
        body: JSON.stringify({ name: draft.name, description: draft.description, dials: draft.dials }),
      })
      if (!r.ok) throw new Error()
      toast.success('Profile saved'); closeEditor(); load()
    } catch { toast.error('Failed to save profile') } finally { setSaving(false) }
  }

  const makeDefault = async (slug: string) => {
    const r = await fetch('/api/admin/content/default-profile', { ...opts, method: 'PUT', headers: J, body: JSON.stringify({ slug }) })
    if (r.ok) { setDefaultSlug(slug); toast.success('Default profile updated') } else toast.error('Failed')
  }

  const create = async () => {
    const r = await fetch('/api/admin/content/profiles', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ name: 'New profile', dials: MIN_DIALS }) })
    if (!r.ok) { toast.error('Failed to create profile'); return }
    const { profile } = await r.json() as { profile: Profile }
    load(profile.slug)  // reload and jump straight into the editor
  }

  const doDelete = async () => {
    if (!delTarget) return
    const r = await fetch(`/api/admin/content/profiles/${delTarget.slug}`, { ...opts, method: 'DELETE' })
    const body = await r.json().catch(() => ({})) as { error?: string }
    if (r.ok) { toast.success('Profile deleted'); if (editingSlug === delTarget.slug) closeEditor(); load() } else toast.error(body.error ?? 'Failed to delete')
    setDelTarget(null)
  }

  if (loading) return <div className="flex items-center justify-center h-32"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>

  // ── Editor (one profile) ────────────────────────────────────────────────────
  if (editingSlug && draft) {
    const open100 = openLabels(draft.dials)
    const isDefault = defaultSlug === draft.slug
    return (
      <div className="max-w-xl">
        <button onClick={closeEditor} className="mb-3 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ChevronLeft className="size-4" /> All profiles
        </button>

        <div className="space-y-4">
          <div className="space-y-2">
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              disabled={draft.isBuiltin}
              placeholder="Profile name"
              className="w-full bg-transparent text-lg font-semibold outline-none border-b border-border/40 focus:border-border pb-1 disabled:opacity-100"
            />
            <textarea
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="Description"
              rows={2}
              className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm outline-none focus:border-brand/60 resize-y"
            />
            <div className="flex items-center gap-2">
              {draft.isBuiltin && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">built-in</span>}
              {isDefault
                ? <span className="rounded-full bg-brand/15 px-2 py-0.5 text-[10px] font-medium text-brand">default for new accounts</span>
                : <button onClick={() => void makeDefault(draft.slug)} className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"><Star className="size-2.5" /> Make default</button>}
            </div>
          </div>

          <div className="rounded-xl border border-border/50 bg-card/40 p-3">
            <ContentDialGroup values={draft.dials} onDial={(k: DialKey, v) => setDraft({ ...draft, dials: { ...draft.dials, [k]: v } })} />
          </div>

          {open100.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2">
              <ShieldAlert className="size-3.5 text-amber-500 mt-0.5 shrink-0" />
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Unrestricted: {open100.join(', ')}. No limit on these topics (minors &amp; mass-casualty weapons always blocked).
              </p>
            </div>
          )}

          <div className="flex items-center gap-2">
            <button onClick={() => void save()} disabled={saving}
              className="flex items-center gap-2 rounded-lg bg-foreground px-3 py-2 text-sm font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-50">
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />} Save
            </button>
            {!draft.isBuiltin && (
              <button onClick={() => setDelTarget(draft)} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:text-destructive hover:bg-muted transition-colors">
                <Trash2 className="size-4" /> Delete
              </button>
            )}
          </div>
        </div>

        <ConfirmDialog open={!!delTarget} onOpenChange={(o) => { if (!o) setDelTarget(null) }}
          title={`Delete "${delTarget?.name}"?`} description="Users on this profile will be reassigned to the default profile."
          confirmLabel="Delete" destructive onConfirm={() => void doDelete()} />
      </div>
    )
  }

  // ── List (master) ───────────────────────────────────────────────────────────
  return (
    <div className="max-w-2xl">
      <div className="mb-4 flex items-start justify-between gap-3">
        {!embedded ? (
          <div>
            <h2 className="text-base font-semibold">Content Profiles</h2>
            <p className="text-sm text-muted-foreground">Named per-category ceilings assigned to users. New accounts get the default; a companion can never exceed the user's profile.</p>
          </div>
        ) : <span />}
        <button onClick={() => void create()} className="flex shrink-0 items-center gap-1 rounded-lg bg-foreground px-3 py-1.5 text-sm font-semibold text-background transition-opacity hover:opacity-90">
          <Plus className="size-3.5" /> New
        </button>
      </div>

      <div className="rounded-xl border border-border/50 divide-y divide-border/30 overflow-hidden">
        {profiles.map((p) => (
          <button key={p.slug} onClick={() => openEditor(p)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left bg-card hover:bg-muted/50 transition-colors">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium truncate">{p.name}</span>
                {defaultSlug === p.slug && <span className="rounded-full bg-brand/15 px-1.5 py-0.5 text-[10px] font-medium text-brand shrink-0">default</span>}
                {p.isBuiltin && <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground shrink-0">built-in</span>}
              </div>
              {p.description && <p className="text-xs text-muted-foreground truncate mt-0.5">{p.description}</p>}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-[11px] text-muted-foreground">{summarize(p.dials)}</span>
              <ChevronRight className="size-4 text-muted-foreground" />
            </div>
          </button>
        ))}
      </div>
      <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground"><Check className="size-3" /> Assign profiles to users in Admin → Users.</p>
    </div>
  )
}
