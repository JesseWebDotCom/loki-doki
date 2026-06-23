import { useCallback, useEffect, useState } from 'react'
import { Plus, Trash2, Save, Star, Loader2, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/cn'
import { AdminAccordion } from '@/components/admin/AdminAccordion'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { ContentDialGroup, MIN_DIALS, normalizeDials, CONTENT_DIALS } from '@/components/shared/contentDials'
import type { ContentDialValues, DialKey } from '@/components/shared/contentDials'
import { toast } from '@/lib/toast'

// Admin content profiles: named sets of per-category ceilings assigned to users.
// Every category tops out at "unrestricted"; the two absolute limits (minors,
// mass-casualty weapons) always apply and are not shown as dials.

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

function unrestrictedLabels(dials: ContentDialValues): string[] {
  return CONTENT_DIALS.filter((d) => dials[d.key] === 'unrestricted').map((d) => d.label)
}

export function ContentProfilesManager({ openSignal }: { openSignal?: string }) {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [defaultSlug, setDefaultSlug] = useState<string>('locked')
  const [loading, setLoading] = useState(true)
  const [drafts, setDrafts] = useState<Record<string, Profile>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [delTarget, setDelTarget] = useState<Profile | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    fetch('/api/admin/content/profiles', opts)
      .then((r) => r.ok ? r.json() : null)
      .then((d: { profiles: Profile[]; defaultSlug: string } | null) => {
        if (!d) return
        const norm = d.profiles.map((p) => ({ ...p, dials: normalizeDials(p.dials, MIN_DIALS) }))
        setProfiles(norm)
        setDefaultSlug(d.defaultSlug)
        setDrafts(Object.fromEntries(norm.map((p) => [p.slug, p])))
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => { load() }, [load])

  const setDial = (slug: string, key: DialKey, value: string) => {
    setDrafts((d) => ({ ...d, [slug]: { ...d[slug]!, dials: { ...d[slug]!.dials, [key]: value } } }))
  }
  const setField = (slug: string, patch: Partial<Profile>) => {
    setDrafts((d) => ({ ...d, [slug]: { ...d[slug]!, ...patch } }))
  }

  const save = async (slug: string) => {
    const draft = drafts[slug]
    if (!draft) return
    setSaving(slug)
    try {
      const r = await fetch(`/api/admin/content/profiles/${slug}`, {
        ...opts, method: 'PUT', headers: J,
        body: JSON.stringify({ name: draft.name, description: draft.description, dials: draft.dials }),
      })
      if (!r.ok) throw new Error()
      toast.success('Profile saved')
      load()
    } catch { toast.error('Failed to save profile') } finally { setSaving(null) }
  }

  const makeDefault = async (slug: string) => {
    const r = await fetch('/api/admin/content/default-profile', { ...opts, method: 'PUT', headers: J, body: JSON.stringify({ slug }) })
    if (r.ok) { setDefaultSlug(slug); toast.success('Default profile updated') } else toast.error('Failed')
  }

  const create = async () => {
    if (!newName.trim()) return
    setCreating(true)
    try {
      const r = await fetch('/api/admin/content/profiles', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ name: newName.trim(), dials: MIN_DIALS }) })
      if (!r.ok) throw new Error()
      setNewName(''); toast.success('Profile created'); load()
    } catch { toast.error('Failed to create profile') } finally { setCreating(false) }
  }

  const doDelete = async () => {
    if (!delTarget) return
    const r = await fetch(`/api/admin/content/profiles/${delTarget.slug}`, { ...opts, method: 'DELETE' })
    const body = await r.json().catch(() => ({})) as { error?: string }
    if (r.ok) { toast.success('Profile deleted'); load() } else toast.error(body.error ?? 'Failed to delete')
    setDelTarget(null)
  }

  return (
    <AdminAccordion id="content-ceiling" title="Content Profiles"
      description="Named sets of per-category ceilings, assigned to users. New accounts get the default profile; a companion can never exceed the user's profile."
      openSignal={openSignal} defaultOpen>
      {loading ? (
        <div className="flex items-center justify-center h-20"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="space-y-3">
          {profiles.map((p) => {
            const draft = drafts[p.slug] ?? p
            const isDefault = defaultSlug === p.slug
            const open100 = unrestrictedLabels(draft.dials)
            return (
              <div key={p.slug} className="rounded-xl border border-border/60 bg-card p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <input
                        value={draft.name}
                        onChange={(e) => setField(p.slug, { name: e.target.value })}
                        disabled={p.isBuiltin}
                        className="bg-transparent text-sm font-semibold outline-none border-b border-transparent focus:border-border disabled:opacity-100 disabled:cursor-default"
                      />
                      {p.isBuiltin && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">built-in</span>}
                      {isDefault && <span className="rounded-full bg-brand/15 px-2 py-0.5 text-[10px] font-medium text-brand">default</span>}
                    </div>
                    <input
                      value={draft.description}
                      onChange={(e) => setField(p.slug, { description: e.target.value })}
                      placeholder="Description"
                      className="w-full bg-transparent text-xs text-muted-foreground outline-none"
                    />
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {!isDefault && (
                      <button onClick={() => void makeDefault(p.slug)} title="Set as default for new accounts"
                        className="rounded-lg p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                        <Star className="size-4" />
                      </button>
                    )}
                    {!p.isBuiltin && (
                      <button onClick={() => setDelTarget(p)} className="rounded-lg p-1.5 text-muted-foreground hover:text-destructive hover:bg-muted transition-colors">
                        <Trash2 className="size-4" />
                      </button>
                    )}
                  </div>
                </div>

                <ContentDialGroup values={draft.dials} onDial={(k, v) => setDial(p.slug, k, v)} />

                {open100.length > 0 && (
                  <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2">
                    <ShieldAlert className="size-3.5 text-amber-500 mt-0.5 shrink-0" />
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      Unrestricted: {open100.join(', ')}. Users on this profile can discuss these topics with no limit (minors &amp; mass-casualty weapons always blocked).
                    </p>
                  </div>
                )}

                <button onClick={() => void save(p.slug)} disabled={saving === p.slug}
                  className="flex items-center gap-2 rounded-lg bg-foreground px-3 py-1.5 text-xs font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-50">
                  {saving === p.slug ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />} Save
                </button>
              </div>
            )
          })}

          <div className="flex gap-2 pt-1">
            <input value={newName} onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void create() }}
              placeholder="New profile name…"
              className="flex-1 rounded-lg border border-border/60 bg-background px-3 py-1.5 text-sm outline-none focus:border-brand/60" />
            <button onClick={() => void create()} disabled={creating || !newName.trim()}
              className="flex items-center gap-1 rounded-lg bg-muted px-3 py-1.5 text-sm font-medium hover:bg-muted/80 transition-colors disabled:opacity-50">
              <Plus className="size-3.5" /> Create
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!delTarget}
        onOpenChange={(o) => { if (!o) setDelTarget(null) }}
        title={`Delete "${delTarget?.name}"?`}
        description="Users on this profile will be reassigned to the default profile."
        confirmLabel="Delete"
        destructive
        onConfirm={() => void doDelete()}
      />
    </AdminAccordion>
  )
}
