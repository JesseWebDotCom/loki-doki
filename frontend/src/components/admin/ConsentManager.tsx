import { useCallback, useEffect, useState } from 'react'
import { Loader2, Save, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'

// Admin consent panel — edits the CURRENT admin's own consents for risky
// capabilities (uncensored content, internet access, AI companions, liability
// waiver). Withholding a consent leaves the app in the safe default. Per-user
// editing (GET/PUT /api/consent/admin/:userId) exists on the backend but isn't
// surfaced here yet (v1).

type ConsentKey = 'uncensored' | 'internet' | 'companions' | 'liability'

interface Consents {
  uncensored: boolean
  internet: boolean
  companions: boolean
  liability: boolean
  acceptedAt: string | null
  version: number
}

interface ConsentDefinition {
  key: ConsentKey
  label: string
  risk: string
  ifDenied: string
}

interface ConsentResponse {
  consents: Consents
  definitions: ConsentDefinition[]
  version: number
}

const opts: RequestInit = { credentials: 'include' }
const J = { 'Content-Type': 'application/json' }
const CONSENT_KEYS: ConsentKey[] = ['uncensored', 'internet', 'companions', 'liability']

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!checked)}
      className={cn('relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors', checked ? 'bg-brand' : 'bg-muted')}>
      <span className={cn('pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition-transform', checked ? 'translate-x-4' : 'translate-x-0')} />
    </button>
  )
}

export function ConsentManager({ embedded = false }: { embedded?: boolean } = {}) {
  const [definitions, setDefinitions] = useState<ConsentDefinition[]>([])
  const [consents, setConsents] = useState<Consents | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    fetch('/api/consent', opts)
      .then((r) => r.ok ? r.json() : null)
      .then((d: ConsentResponse | null) => {
        if (!d) return
        setDefinitions(d.definitions)
        setConsents(d.consents)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => { load() }, [load])

  const set = (key: ConsentKey, value: boolean) =>
    setConsents((c) => (c ? { ...c, [key]: value } : c))

  const save = async () => {
    if (!consents) return
    setSaving(true)
    try {
      const r = await fetch('/api/consent', {
        ...opts, method: 'PUT', headers: J,
        body: JSON.stringify({
          uncensored: consents.uncensored,
          internet: consents.internet,
          companions: consents.companions,
          liability: consents.liability,
          accept: true,
        }),
      })
      if (!r.ok) throw new Error()
      const { consents: next } = await r.json() as { consents: Consents }
      setConsents(next)
      toast.success('Consent settings saved')
    } catch { toast.error('Failed to save consent settings') } finally { setSaving(false) }
  }

  if (loading) return <div className="flex items-center justify-center h-32"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
  if (!consents) return <p className="text-sm text-muted-foreground">Consent settings unavailable.</p>

  const ordered = CONSENT_KEYS
    .map((key) => definitions.find((d) => d.key === key))
    .filter((d): d is ConsentDefinition => !!d)
  const acceptedLabel = consents.acceptedAt ? new Date(consents.acceptedAt).toLocaleString() : 'Never accepted'

  return (
    <div className="max-w-3xl">
      {!embedded && (
        <div className="mb-4">
          <h2 className="text-base font-semibold">Consent</h2>
          <p className="text-sm text-muted-foreground">
            Your consent for risky capabilities. Withholding a consent leaves that feature in its safe default.
          </p>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-border/50 divide-y divide-border/40">
        {ordered.map((def) => {
          const checked = consents[def.key]
          return (
            <div key={def.key} className="flex items-start gap-3 bg-card px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{def.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{def.risk}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground/70">{def.ifDenied}</p>
              </div>
              <Toggle checked={checked} onChange={(v) => set(def.key, v)} />
            </div>
          )
        })}
      </div>

      {!consents.liability && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2">
          <ShieldAlert className="size-3.5 text-amber-500 mt-0.5 shrink-0" />
          <p className="text-xs text-amber-700 dark:text-amber-400">
            The liability waiver is off. Generative features stay disabled until you accept it.
          </p>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border/40 pt-4">
        <button onClick={() => void save()} disabled={saving}
          className="flex items-center gap-2 rounded-lg bg-foreground px-4 py-2 text-sm font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-50">
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />} Save changes
        </button>
        <p className="text-xs text-muted-foreground">Last accepted: {acceptedLabel}</p>
      </div>

      <p className="mt-2 text-[11px] text-muted-foreground/70">
        Editing another user's consent isn't available here yet — this panel manages your own.
      </p>
    </div>
  )
}
