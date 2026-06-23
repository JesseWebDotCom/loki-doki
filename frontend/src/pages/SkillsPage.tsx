import { useCallback, useEffect, useState } from 'react'
import { Loader2, Plus, Sparkles, Trash2, Pencil } from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { usePublishUIContext } from '@/context/UIContextProvider'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/cn'

interface SkillState {
  name: string
  description: string
  scope: 'family' | 'user'
  enabled: boolean
  source: 'default' | 'user_toggle' | 'admin_assign'
  alwaysActive: boolean
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...init })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error((data as { error?: string }).error ?? `Error ${r.status}`), data)
  return data as T
}

function buildMarkdown(name: string, description: string, alwaysActive: boolean, body: string): string {
  const fm = ['---', `name: ${name}`, `description: ${description}`]
  if (alwaysActive) fm.push('always_active: true')
  fm.push('---', '', body.trim(), '')
  return fm.join('\n')
}

// ── Editor modal ────────────────────────────────────────────────────────────────

function SkillEditor({
  editing, onClose, onSaved,
}: {
  editing: SkillState | null  // null = create mode
  onClose: () => void
  onSaved: (skills: SkillState[]) => void
}) {
  const isEdit = !!editing
  const [name, setName] = useState(editing?.name ?? '')
  const [description, setDescription] = useState(editing?.description ?? '')
  const [alwaysActive, setAlwaysActive] = useState(editing?.alwaysActive ?? false)
  const [body, setBody] = useState('')
  const [raw, setRaw] = useState(false)
  const [rawText, setRawText] = useState('')
  const [loading, setLoading] = useState(isEdit)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Load the existing file in edit mode.
  useEffect(() => {
    if (!editing) return
    void api<{ markdown: string }>(`/api/skills/${editing.name}/file`)
      .then((d) => {
        setRawText(d.markdown)
        const split = d.markdown.split(/\n---\s*\n/)
        setBody(split.length > 1 ? split.slice(1).join('\n---\n').trim() : '')
      })
      .catch(() => setError('Could not load this skill file.'))
      .finally(() => setLoading(false))
  }, [editing])

  const save = useCallback(async () => {
    setError(null)
    const markdown = raw ? rawText : buildMarkdown(name.trim(), description.trim(), alwaysActive, body)
    const effectiveName = raw ? (markdown.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? '') : name.trim()
    if (!NAME_RE.test(effectiveName)) {
      setError('Name must be 1–64 chars: lowercase letters, digits, "-" or "_".')
      return
    }
    if (!raw && !description.trim()) { setError('A description is required.'); return }
    setSaving(true)
    try {
      const method = isEdit ? 'PUT' : 'POST'
      const res = await api<{ skills: SkillState[] }>(`/api/skills/${effectiveName}/file`, {
        method,
        body: JSON.stringify({ markdown }),
      })
      toast.success(isEdit ? 'Skill updated' : 'Skill created')
      onSaved(res.skills)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }, [raw, rawText, name, description, alwaysActive, body, isEdit, onSaved, onClose])

  const remove = useCallback(async () => {
    if (!editing) return
    try {
      const res = await api<{ skills: SkillState[] }>(`/api/skills/${editing.name}/file`, { method: 'DELETE' })
      toast.success('Skill deleted')
      onSaved(res.skills)
      onClose()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }, [editing, onSaved, onClose])

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit "${editing!.name}"` : 'Author a skill'}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin" /></div>
        ) : raw ? (
          <textarea
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            spellCheck={false}
            className="h-72 w-full rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs"
            placeholder={'---\nname: my-skill\ndescription: ...\n---\n\nInstructions...'}
          />
        ) : (
          <div className="space-y-3">
            <div>
              <label className="text-xs font-semibold text-muted-foreground">Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase())}
                disabled={isEdit}
                placeholder="e.g. concise-replies"
                className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm disabled:opacity-60"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground">Description</label>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="One line — what this skill does"
                className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground">Instructions</label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="How the companion should behave when this skill is active…"
                className="mt-1 h-40 w-full rounded-lg border border-border bg-background p-3 text-sm"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={alwaysActive} onChange={(e) => setAlwaysActive(e.target.checked)} />
              Always active (apply on every message)
            </label>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter className="flex items-center gap-2 sm:justify-between">
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setRaw((v) => !v)}>
              {raw ? 'Form' : 'Raw markdown'}
            </Button>
            {isEdit && (
              <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="size-4" /> Delete
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />} Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this skill?"
        description="This permanently removes the skill file."
        confirmLabel="Delete"
        destructive
        onConfirm={() => void remove()}
      />
    </Dialog>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function SkillsPage() {
  const [skills, setSkills] = useState<SkillState[] | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [editor, setEditor] = useState<{ editing: SkillState | null } | null>(null)

  usePublishUIContext({ label: 'Skills', description: 'User is managing custom companion skills.' })

  const load = useCallback(async () => {
    setStatus('loading')
    try {
      const d = await api<{ skills: SkillState[] }>('/api/skills')
      setSkills(d.skills)
      setStatus('ready')
    } catch {
      setStatus('error')
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const toggle = useCallback(async (s: SkillState) => {
    setSkills((cur) => cur?.map((x) => (x.name === s.name ? { ...x, enabled: !x.enabled } : x)) ?? cur)
    try {
      const d = await api<{ skills: SkillState[] }>(`/api/skills/${s.name}`, {
        method: 'POST', body: JSON.stringify({ enabled: !s.enabled }),
      })
      setSkills(d.skills)
    } catch (e) {
      toast.error((e as Error).message)
      void load()
    }
  }, [load])

  return (
    <PageShell gradient="linear-gradient(135deg,#312e81,#7c3aed)" GhostIcon={Sparkles}>
      <div className="flex items-center justify-between px-5 pt-5 pb-2 shrink-0">
        <h1 className="text-xl font-black tracking-tight">Skills</h1>
        <Button size="sm" onClick={() => setEditor({ editing: null })}>
          <Plus className="size-4" /> Author a skill
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-8 sm:px-5">
        <p className="mb-4 text-sm text-muted-foreground">
          Skills are reusable instructions that shape how your companion replies. Toggle one on and it applies to your chats.
        </p>

        {status === 'loading' && (
          <div className="flex justify-center py-16 text-muted-foreground"><Loader2 className="size-6 animate-spin" /></div>
        )}
        {status === 'error' && <p className="py-10 text-center text-sm text-destructive">Couldn't load skills.</p>}
        {status === 'ready' && skills?.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">No skills yet. Author one to get started.</p>
        )}

        <div className="space-y-2">
          {skills?.map((s) => (
            <div key={s.name} className="flex items-center gap-3 rounded-xl border border-border/60 bg-card p-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-semibold">{s.name}</span>
                  <span className={cn(
                    'rounded-full px-2 py-0.5 text-[10px] font-medium',
                    s.scope === 'user' ? 'bg-brand/15 text-brand' : 'bg-muted text-muted-foreground',
                  )}>
                    {s.scope === 'user' ? 'Your skill' : 'Shared'}
                  </span>
                  {s.alwaysActive && (
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600">Always on</span>
                  )}
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{s.description}</p>
              </div>
              {s.scope === 'user' && (
                <button onClick={() => setEditor({ editing: s })} className="text-muted-foreground hover:text-foreground">
                  <Pencil className="size-4" />
                </button>
              )}
              <button
                role="switch"
                aria-checked={s.enabled}
                onClick={() => void toggle(s)}
                className={cn(
                  'relative h-6 w-11 shrink-0 rounded-full transition-colors',
                  s.enabled ? 'bg-brand' : 'bg-muted-foreground/30',
                )}
              >
                <span className={cn(
                  'absolute top-0.5 size-5 rounded-full bg-white transition-transform',
                  s.enabled ? 'translate-x-5' : 'translate-x-0.5',
                )} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {editor && (
        <SkillEditor
          editing={editor.editing}
          onClose={() => setEditor(null)}
          onSaved={(next) => setSkills(next)}
        />
      )}
    </PageShell>
  )
}
