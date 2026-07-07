import { useEffect, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { ToggleRow } from '@/components/shared/ToggleRow'

// Renders a tool's global-scope config fields (API keys, base URLs, toggles),
// reading the schema from /api/tools and values from /api/tools/config/global.
// Lets an app's own settings page host the config that used to live only on
// the generic Admin -> Apps -> App Settings list.

interface ConfigField {
  key: string
  label: string
  description?: string
  type: 'string' | 'number' | 'boolean' | 'secret'
  scope: 'global' | 'user' | 'both'
  placeholder?: string
  default?: string | number | boolean
}

interface ToolInfo {
  id: string
  configSchema: ConfigField[]
}

export function ToolConfigFields({ toolId, onlyKeys, excludeKeys }: {
  toolId: string
  /** Render only these config keys (e.g. to add one field alongside a bespoke form). */
  onlyKeys?: string[]
  /** Render every global field except these (e.g. ones a bespoke form already covers). */
  excludeKeys?: string[]
}) {
  const [fields, setFields] = useState<ConfigField[] | null>(null)
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({})

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch('/api/tools', { credentials: 'include' }).then(r => r.json()).catch(() => []),
      fetch('/api/tools/config/global', { credentials: 'include' }).then(r => r.json()).catch(() => ({})),
    ]).then(([tools, cfg]) => {
      if (cancelled) return
      const tool = Array.isArray(tools) ? (tools as ToolInfo[]).find(t => t.id === toolId) : undefined
      let globalFields = (tool?.configSchema ?? []).filter(f => f.scope === 'global' || f.scope === 'both')
      if (onlyKeys) globalFields = globalFields.filter(f => onlyKeys.includes(f.key))
      if (excludeKeys) globalFields = globalFields.filter(f => !excludeKeys.includes(f.key))
      setFields(globalFields)
      setConfig((cfg as Record<string, Record<string, unknown>>)?.[toolId] ?? {})
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolId])

  async function save(key: string, value: string | boolean) {
    setSaving(prev => ({ ...prev, [key]: true }))
    await fetch('/api/tools/config/global', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ toolId, key, value }),
    }).catch(() => {})
    setConfig(prev => ({ ...prev, [key]: value }))
    setDrafts(prev => { const next = { ...prev }; delete next[key]; return next })
    setSaving(prev => ({ ...prev, [key]: false }))
  }

  if (fields === null) return <Spinner size="sm" className="text-muted-foreground" />
  if (fields.length === 0) return null

  return (
    <div className="space-y-3">
      {fields.map(field => {
        const rawVal = config[field.key] ?? field.default

        if (field.type === 'boolean') {
          const checked = rawVal === true
          return (
            <ToggleRow key={field.key} title={field.label} description={field.description ?? ''}
              checked={checked} disabled={saving[field.key]} onCheckedChange={() => save(field.key, !checked)} />
          )
        }

        const currentVal = String(rawVal ?? '')
        const draftVal   = drafts[field.key]
        const displayVal = draftVal ?? currentVal
        const isSecret   = field.type === 'secret'
        const visible    = showSecret[field.key]
        const isDirty    = draftVal !== undefined && draftVal !== currentVal

        return (
          <div key={field.key} className="space-y-1.5">
            <label className="text-xs font-medium">{field.label}</label>
            {field.description && <p className="text-[10px] text-muted-foreground/60">{field.description}</p>}
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type={isSecret && !visible ? 'password' : 'text'}
                  value={displayVal}
                  placeholder={field.placeholder}
                  onChange={e => setDrafts(prev => ({ ...prev, [field.key]: e.target.value }))}
                  className="w-full rounded-control border border-border bg-background px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-brand/40 pr-8"
                />
                {isSecret && (
                  <button type="button" onClick={() => setShowSecret(prev => ({ ...prev, [field.key]: !visible }))}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-muted-foreground transition-colors">
                    {visible ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                  </button>
                )}
              </div>
              {isDirty && (
                <Button type="button" size="sm" disabled={saving[field.key]} onClick={() => save(field.key, draftVal!)} className="shrink-0">
                  {saving[field.key] ? '…' : 'Save'}
                </Button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
