import { useCallback, useEffect, useState } from 'react'
import { Save, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Spinner } from '@/components/ui/spinner'
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

  if (loading) return <div className="flex items-center justify-center h-32"><Spinner size="lg" /></div>
  if (!consents) return <p className="text-sm text-muted-foreground">Consent settings unavailable.</p>

  const ordered = CONSENT_KEYS
    .map((key) => definitions.find((d) => d.key === key))
    .filter((d): d is ConsentDefinition => !!d)
  const acceptedLabel = consents.acceptedAt ? new Date(consents.acceptedAt).toLocaleString() : 'Never accepted'

  return (
    <div className="max-w-3xl">
      {!embedded && (
        <div className="mb-4">
          <h2 className="text-section">Consent</h2>
          <p className="text-sm text-muted-foreground">
            Your consent for risky capabilities. Withholding a consent leaves that feature in its safe default.
          </p>
        </div>
      )}

      <Card variant="surface" className="divide-y divide-border/40 border-border/50">
        {ordered.map((def) => {
          const checked = consents[def.key]
          return (
            <div key={def.key} className="flex items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{def.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{def.risk}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground/70">{def.ifDenied}</p>
              </div>
              <Switch checked={checked} onCheckedChange={(v) => set(def.key, v)} className="mt-0.5" />
            </div>
          )
        })}
      </Card>

      {!consents.liability && (
        <div className="mt-3 flex items-start gap-2 rounded-control border border-warning/20 bg-warning/10 px-3 py-2">
          <ShieldAlert className="size-3.5 text-warning mt-0.5 shrink-0" />
          <p className="text-xs text-warning">
            The liability waiver is off. Generative features stay disabled until you accept it.
          </p>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border/40 pt-4">
        <Button onClick={() => void save()} disabled={saving} className="gap-2">
          {saving ? <Spinner size="sm" className="text-current" /> : <Save className="size-3.5" />} Save changes
        </Button>
        <p className="text-xs text-muted-foreground">Last accepted: {acceptedLabel}</p>
      </div>

      <p className="mt-2 text-[11px] text-muted-foreground/70">
        Editing another user's consent isn't available here yet — this panel manages your own.
      </p>
    </div>
  )
}
