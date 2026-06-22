import { useEffect, useState } from 'react'
import {
  ArrowLeftRight, BookOpen, Calculator, CalendarClock, ChefHat,
  Cloud, Eye, EyeOff, Globe, Laugh, Loader2, MapPin, Newspaper,
  Play, Save, ShieldCheck, Trash2, Trophy, Tv, Wifi, WifiOff, Wrench,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/cn'
import { useAuth } from '@/context/AuthContext'

// Mirrors TOOL_ICONS in AdminFeaturesTab — same icon + chip color per tool id.
const TOOL_ICONS: Record<string, { icon: LucideIcon; chip: string }> = {
  weather:         { icon: Cloud,          chip: 'bg-sky-500/15 text-sky-500'      },
  search:          { icon: Globe,          chip: 'bg-blue-500/15 text-blue-500'     },
  news:            { icon: Newspaper,      chip: 'bg-orange-500/15 text-orange-500' },
  dictionary:      { icon: BookOpen,       chip: 'bg-amber-500/15 text-amber-500'   },
  calculator:      { icon: Calculator,     chip: 'bg-brand/15 text-brand'           },
  unit_conversion: { icon: ArrowLeftRight, chip: 'bg-teal-500/15 text-teal-500'     },
  jokes:           { icon: Laugh,          chip: 'bg-yellow-500/15 text-yellow-500' },
  recipes:         { icon: ChefHat,        chip: 'bg-emerald-500/15 text-emerald-500'},
  youtube:         { icon: Play,           chip: 'bg-red-500/15 text-red-500'       },
  tvshows:         { icon: Tv,             chip: 'bg-purple-500/15 text-purple-500' },
  onthisday:       { icon: CalendarClock,  chip: 'bg-indigo-500/15 text-indigo-500' },
  localNews:       { icon: Newspaper,      chip: 'bg-rose-500/15 text-rose-500'     },
  localEvents:     { icon: MapPin,         chip: 'bg-green-500/15 text-green-500'   },
  contentRating:   { icon: ShieldCheck,    chip: 'bg-amber-500/15 text-amber-500'   },
  sports:          { icon: Trophy,         chip: 'bg-yellow-500/15 text-yellow-600' },
}

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
  name: string
  description: string
  offline: boolean
  configSchema: ConfigField[]
  enabled: boolean
}

type UserConfig = Record<string, Record<string, unknown>>

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T | null> {
  try {
    const r = await fetch(url, { credentials: 'include', ...options })
    if (!r.ok) return null
    return await r.json() as T
  } catch {
    return null
  }
}

export function SettingsToolsTab() {
  const { user } = useAuth()
  const [tools, setTools]   = useState<ToolInfo[]>([])
  const [config, setConfig] = useState<UserConfig>({})
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState<string | null>(null)
  const [connectivityMode, setConnectivityMode] = useState<'online' | 'offline'>('online')
  const [connectivitySaving, setConnectivitySaving] = useState(false)

  useEffect(() => {
    if (!user?.id) return
    apiFetch<Record<string, unknown>>(`/api/users/${user.id}/preferences`).then(prefs => {
      if (prefs && prefs['connectivity.mode'] === 'offline') setConnectivityMode('offline')
    })
  }, [user?.id])

  useEffect(() => {
    let cancelled = false
    async function load() {
      const toolsData = await apiFetch<ToolInfo[]>('/api/tools')
      if (cancelled) return
      if (!Array.isArray(toolsData)) {
        setError('Could not load tools.')
        setLoading(false)
        return
      }
      setTools(toolsData)

      const configData = await apiFetch<UserConfig>('/api/tools/config/user')
      if (cancelled) return
      if (configData && typeof configData === 'object') setConfig(configData)
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [])

  const userFields = (tool: ToolInfo) =>
    tool.configSchema.filter(f => f.scope === 'user' || f.scope === 'both')

  const currentValue = (toolId: string, key: string): string => {
    const draft = drafts[toolId]?.[key]
    if (draft !== undefined) return draft
    const stored = config[toolId]?.[key]
    return stored !== undefined ? String(stored) : ''
  }

  async function saveKey(toolId: string, field: ConfigField) {
    const stateKey = `${toolId}.${field.key}`
    setSaving(s => ({ ...s, [stateKey]: true }))
    try {
      const raw = drafts[toolId]?.[field.key] ?? String(config[toolId]?.[field.key] ?? '')
      const value = field.type === 'number' ? Number(raw) : field.type === 'boolean' ? raw === 'true' : raw
      const ok = await apiFetch('/api/tools/config/user', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolId, key: field.key, value }),
      })
      if (ok !== null) {
        setConfig(c => ({ ...c, [toolId]: { ...c[toolId], [field.key]: value } }))
        setDrafts(d => { const n = { ...d }; delete n[toolId]?.[field.key]; return n })
      }
    } finally {
      setSaving(s => ({ ...s, [stateKey]: false }))
    }
  }

  async function clearKey(toolId: string, key: string) {
    const ok = await apiFetch('/api/tools/config/user', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolId, key }),
    })
    if (ok !== null) {
      setConfig(c => {
        const n = { ...c, [toolId]: { ...c[toolId] } }
        delete n[toolId][key]
        return n
      })
      setDrafts(d => { const n = { ...d }; delete n[toolId]?.[key]; return n })
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    )
  }

  const configurableTools = tools.filter(t => t.enabled !== false && userFields(t).length > 0)

  if (!configurableTools.length) {
    return (
      <div className="flex h-40 items-center justify-center">
        <p className="text-sm text-muted-foreground">No personal tool settings available.</p>
      </div>
    )
  }

  return (
    <div className="p-4 space-y-3">
      <div className="overflow-hidden rounded-2xl border border-border/60 bg-card">
        <div className="flex items-center gap-3 px-4 py-3">
          <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl',
            connectivityMode === 'offline' ? 'bg-amber-500/15 text-amber-500' : 'bg-emerald-500/15 text-emerald-500'
          )}>
            {connectivityMode === 'offline' ? <WifiOff className="size-5" /> : <Wifi className="size-5" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold leading-tight">
                  {connectivityMode === 'offline' ? 'Local only' : 'Standard'}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-snug">
                  {connectivityMode === 'offline'
                    ? 'Internet features are off — only local tools work'
                    : 'All tools and features can use the internet'}
                </p>
              </div>
              <Switch
                checked={connectivityMode === 'online'}
                disabled={connectivitySaving}
                onCheckedChange={async (v) => {
                  const newMode = v ? 'online' : 'offline'
                  setConnectivitySaving(true)
                  setConnectivityMode(newMode)
                  await apiFetch(`/api/users/${user?.id}/preferences`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 'connectivity.mode': newMode }),
                  })
                  setConnectivitySaving(false)
                }}
              />
            </div>
          </div>
        </div>
      </div>

      <p className="text-xs text-muted-foreground pb-1">
        Your personal preferences override admin defaults.
      </p>

      {configurableTools.map(tool => {
        const meta = TOOL_ICONS[tool.id] ?? { icon: Wrench, chip: 'bg-muted text-muted-foreground' }
        const ToolIcon = meta.icon
        const fields = userFields(tool)

        return (
          <div key={tool.id} className="overflow-hidden rounded-2xl border border-border/60 bg-card">
            {/* Tool header — same layout as Admin > Features > Tools */}
            <div className="flex items-center gap-3 px-4 py-3">
              <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl', meta.chip)}>
                <ToolIcon className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-semibold leading-tight">{tool.name}</p>
                  {!tool.offline && (
                    <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground/40">
                      <Wifi className="size-2.5" /> internet
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{tool.description}</p>
              </div>
            </div>

            {/* Config fields */}
            <div className="border-t border-border/50 px-4 py-3 space-y-4">
              {fields.map(field => {
                const stateKey = `${tool.id}.${field.key}`
                const val = currentValue(tool.id, field.key)
                const isSet = (config[tool.id]?.[field.key] ?? '') !== ''
                const isDirty = drafts[tool.id]?.[field.key] !== undefined
                const isSaving = saving[stateKey]

                return (
                  <div key={field.key} className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <Label className="text-xs font-medium">{field.label}</Label>
                      {isSet && !isDirty && (
                        <span className="text-[10px] font-semibold text-emerald-500">set</span>
                      )}
                    </div>
                    {field.description && (
                      <p className="text-[10px] text-muted-foreground/60">{field.description}</p>
                    )}

                    {field.type === 'boolean' ? (
                      <Switch
                        checked={val === 'true'}
                        onCheckedChange={v => setDrafts(d => ({ ...d, [tool.id]: { ...d[tool.id], [field.key]: String(v) } }))}
                      />
                    ) : (
                      <div className="flex gap-2">
                        <div className="relative flex-1">
                          <Input
                            type={field.type === 'secret' && !showSecret[stateKey] ? 'password' : 'text'}
                            value={val}
                            onChange={e => setDrafts(d => ({ ...d, [tool.id]: { ...d[tool.id], [field.key]: e.target.value } }))}
                            placeholder={field.placeholder ?? ''}
                            className="text-xs h-8 pr-8 rounded-lg"
                          />
                          {field.type === 'secret' && (
                            <button
                              type="button"
                              onClick={() => setShowSecret(s => ({ ...s, [stateKey]: !s[stateKey] }))}
                              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                            >
                              {showSecret[stateKey] ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                            </button>
                          )}
                        </div>
                        <Button
                          size="sm" variant="outline"
                          className={cn('h-8 px-2.5 shrink-0', isDirty && 'border-brand/50 text-brand')}
                          disabled={isSaving || (!isDirty && !val)}
                          onClick={() => saveKey(tool.id, field)}
                        >
                          {isSaving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                        </Button>
                        {isSet && (
                          <Button
                            size="sm" variant="ghost"
                            className="h-8 px-2 shrink-0 text-muted-foreground hover:text-destructive"
                            onClick={() => clearKey(tool.id, field.key)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
