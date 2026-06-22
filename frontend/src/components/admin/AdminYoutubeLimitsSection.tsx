import { useEffect, useState } from 'react'
import { Loader2, RefreshCw, CheckCircle2, AlertTriangle } from 'lucide-react'

// Admin control for Save-quality caps: one global ceiling plus optional per-user
// overrides. Mirrors the protections/grant admin patterns — writes go straight to
// the backend, which stores them in appSettings (not user-writable).

interface LimitUser {
  id: string
  firstName: string
  nickname: string
  role: 'admin' | 'user'
  cap: number | null   // null = follows global default
}

interface LimitsResponse {
  tiers: number[]
  defaultCap: number
  globalCap: number
  users: LimitUser[]
}

export function AdminYoutubeLimitsSection() {
  const [data, setData] = useState<LimitsResponse | null>(null)
  const [saving, setSaving] = useState<Record<string, boolean>>({})

  async function load() {
    const r = await fetch('/api/youtube/admin/limits', { credentials: 'include' })
    setData(await r.json() as LimitsResponse)
  }
  useEffect(() => { load().catch(() => {}) }, [])

  async function saveGlobal(height: number) {
    setSaving(s => ({ ...s, global: true }))
    setData(d => d ? { ...d, globalCap: height } : d)
    await fetch('/api/youtube/admin/limits/global', {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ height }),
    }).catch(() => {})
    setSaving(s => ({ ...s, global: false }))
  }

  async function saveUser(userId: string, height: number | null) {
    setSaving(s => ({ ...s, [userId]: true }))
    setData(d => d ? { ...d, users: d.users.map(u => u.id === userId ? { ...u, cap: height } : u) } : d)
    await fetch(`/api/youtube/admin/limits/${userId}`, {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ height }),
    }).catch(() => {})
    setSaving(s => ({ ...s, [userId]: false }))
  }

  if (!data) return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Loading save limits…</div>
  )

  const nonAdmins = data.users.filter(u => u.role !== 'admin')

  return (
    <div className="space-y-5">
      <YtDlpStatusBlock />

      <div className="space-y-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">Save quality limits</p>

      {/* Global cap */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium">Max for everyone</p>
          <p className="text-[10px] text-muted-foreground/60">Ceiling applied when anyone Saves a video offline.</p>
        </div>
        <select
          value={data.globalCap}
          disabled={saving.global}
          onChange={e => saveGlobal(Number(e.target.value))}
          className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs"
        >
          {data.tiers.map(t => <option key={t} value={t}>{t}p</option>)}
        </select>
      </div>

      {/* Per-user overrides */}
      {nonAdmins.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] text-muted-foreground/60">Per-user override</p>
          {nonAdmins.map(u => (
            <div key={u.id} className="flex items-center justify-between gap-3">
              <span className="text-xs">{u.nickname || u.firstName}</span>
              <select
                value={u.cap ?? ''}
                disabled={saving[u.id]}
                onChange={e => saveUser(u.id, e.target.value === '' ? null : Number(e.target.value))}
                className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs"
              >
                <option value="">Global default ({data.globalCap}p)</option>
                {data.tiers.map(t => <option key={t} value={t}>{t}p</option>)}
              </select>
            </div>
          ))}
        </div>
      )}
      </div>
    </div>
  )
}

// ── yt-dlp binary health ─────────────────────────────────────────────────────────

interface YtDlpStatus {
  binary: string
  managed: boolean
  version: string | null
  checkedAt: number | null
}

function YtDlpStatusBlock() {
  const [status, setStatus] = useState<YtDlpStatus | null>(null)
  const [checking, setChecking] = useState(false)

  async function load() {
    const r = await fetch('/api/youtube/admin/ytdlp', { credentials: 'include' })
    if (r.ok) setStatus(await r.json() as YtDlpStatus)
  }
  useEffect(() => { load().catch(() => {}) }, [])

  async function checkNow() {
    setChecking(true)
    try {
      const r = await fetch('/api/youtube/admin/ytdlp/check', { method: 'POST', credentials: 'include' })
      if (r.ok) setStatus(await r.json() as YtDlpStatus)
    } catch { /* best-effort */ } finally { setChecking(false) }
  }

  const checkedLabel = status?.checkedAt ? new Date(status.checkedAt).toLocaleString() : 'never'
  const ok = !!status?.version

  return (
    <div className="space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">yt-dlp engine</p>
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/40 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2.5">
          {ok ? <CheckCircle2 className="size-4 shrink-0 text-emerald-500" /> : <AlertTriangle className="size-4 shrink-0 text-amber-500" />}
          <div className="min-w-0">
            <p className="text-xs font-medium">
              {status ? (status.version ? `Version ${status.version}` : 'Not detected') : 'Loading…'}
              {status && <span className="ml-1.5 text-[10px] text-muted-foreground/60">({status.managed ? 'auto-managed' : 'system'})</span>}
            </p>
            <p className="truncate text-[10px] text-muted-foreground/60">Last checked {checkedLabel} · auto-updates weekly</p>
          </div>
        </div>
        <button onClick={checkNow} disabled={checking}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium transition hover:bg-accent disabled:opacity-60">
          {checking ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          {checking ? 'Checking…' : 'Check now'}
        </button>
      </div>
    </div>
  )
}
