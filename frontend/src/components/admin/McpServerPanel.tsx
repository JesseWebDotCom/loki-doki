import { useCallback, useEffect, useState } from 'react'
import { Copy, KeyRound, Plug, RefreshCw } from 'lucide-react'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'

interface McpConfig {
  enabled: boolean
  token: string | null
  userId: string | null
  exposedToolIds: string[]
}

interface ToolInfo { id: string; name: string; description: string }
interface Member { id: string; name: string }
interface Payload { config: McpConfig; tools: ToolInfo[]; users: Member[] }

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/admin/mcp${path}`, {
    credentials: 'include',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  try {
    return (await r.json()) as T
  } catch {
    throw new Error(`Unexpected response (${r.status})`)
  }
}

export function McpServerPanel() {
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await api<Payload>(''))
    } catch {
      toast.error('Could not load MCP settings')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function save(patch: Partial<McpConfig>) {
    if (!data) return
    const next = { ...data.config, ...patch }
    setData({ ...data, config: next })
    setSaving(true)
    try {
      const res = await api<{ ok: boolean; error?: string; config?: McpConfig }>('/config', {
        method: 'PUT',
        body: JSON.stringify(next),
      })
      if (!res.ok) {
        toast.error(res.error ?? 'Could not save MCP settings')
        await load()
        return
      }
      if (res.config) setData((d) => (d ? { ...d, config: res.config! } : d))
    } finally {
      setSaving(false)
    }
  }

  async function rotate() {
    const res = await api<{ ok: boolean; token?: string }>('/rotate-token', { method: 'POST' })
    if (res.ok) { toast.success('Generated a new token'); await load() }
  }

  function copyToken() {
    if (!data?.config.token) return
    void navigator.clipboard.writeText(data.config.token)
    toast.success('Token copied')
  }

  if (loading) return <div className="flex justify-center py-10"><Spinner /></div>
  if (!data) return <div className="text-sm text-destructive p-5">Could not load MCP settings.</div>

  const { config } = data
  const endpoint = `${window.location.origin}/api/mcp`

  return (
    <div className="p-5 space-y-5 max-w-3xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-medium flex items-center gap-2">
            <Plug className="size-4 text-brand" /> Model Context Protocol server
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            Let a household member's own AI client (like Claude) reach chosen abilities of this hub:
            search notes, check the calendar, ask what a camera saw. Requests run as the member you pick,
            so their permissions and privacy apply.
          </p>
        </div>
        <Switch checked={config.enabled} onCheckedChange={(v) => void save({ enabled: v })} aria-label="Enable MCP server" />
      </div>

      {/* ── Acting user ── */}
      <label className="block space-y-1.5 text-sm">
        <span className="text-muted-foreground">Requests act as</span>
        <select
          value={config.userId ?? ''}
          onChange={(e) => void save({ userId: e.target.value || null })}
          className="w-full h-9 rounded-control border border-input bg-transparent px-3 text-sm"
        >
          <option value="">Choose a household member</option>
          {data.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </label>

      {/* ── Connection details ── */}
      {config.enabled && config.token && (
        <div className="rounded-card border border-border bg-card p-4 space-y-3 text-sm">
          <div className="font-medium">Connection</div>
          <div className="space-y-1">
            <span className="text-muted-foreground text-xs">Endpoint</span>
            <code className="block text-xs text-foreground/80 break-all">{endpoint}</code>
          </div>
          <div className="space-y-1">
            <span className="text-muted-foreground text-xs">Token (send as a Bearer header)</span>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs text-foreground/80 break-all rounded-control bg-muted/40 px-2 py-1.5">{config.token}</code>
              <Button size="icon" variant="ghost" aria-label="Copy token" onClick={copyToken}><Copy className="size-4" /></Button>
              <Button size="icon" variant="ghost" aria-label="Rotate token" onClick={() => void rotate()}><RefreshCw className="size-4" /></Button>
            </div>
          </div>
        </div>
      )}
      {config.enabled && !config.token && (
        <div className="rounded-control border border-border bg-muted/30 p-3 text-sm flex items-center gap-2">
          <KeyRound className="size-4 text-muted-foreground" />
          <span>Pick an acting member and save to generate the access token.</span>
        </div>
      )}

      {/* ── Exposed tools ── */}
      <div className="space-y-2">
        <div className="text-sm font-medium">Exposed abilities</div>
        <p className="text-xs text-muted-foreground">
          Only what you check here is reachable, and only if the acting member is allowed to use it.
        </p>
        <div className="rounded-card border border-border divide-y divide-border overflow-hidden max-h-96 overflow-y-auto">
          {data.tools.map((tool) => {
            const on = config.exposedToolIds.includes(tool.id)
            return (
              <label key={tool.id} className="flex items-start gap-3 px-4 py-2.5 bg-card cursor-pointer">
                <input type="checkbox"
                  checked={on}
                  onChange={(e) => void save({
                    exposedToolIds: e.target.checked
                      ? [...config.exposedToolIds, tool.id]
                      : config.exposedToolIds.filter((id) => id !== tool.id),
                  })}
                  className="mt-1 accent-[var(--brand)]"
                />
                <div className="min-w-0">
                  <div className="text-sm">{tool.name}</div>
                  <div className="text-xs text-muted-foreground line-clamp-2">{tool.description}</div>
                </div>
              </label>
            )
          })}
        </div>
      </div>

      {saving && <div className="text-xs text-muted-foreground">Saving</div>}
    </div>
  )
}
