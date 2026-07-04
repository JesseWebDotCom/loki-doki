import { useEffect, useRef, useState } from 'react'
import { RefreshCw, CheckCircle2, AlertTriangle, Upload, X } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/toast'

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
    <div className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner size="sm" /> Loading save limits…</div>
  )

  const nonAdmins = data.users.filter(u => u.role !== 'admin')

  return (
    <div className="space-y-5">
      <YtDlpStatusBlock />
      <CookiesBlock />

      <div className="space-y-3">
      <p className="text-overline text-muted-foreground/60">Save quality limits</p>

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
          className="rounded-control border border-border bg-background px-2 py-1.5 text-xs"
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
                className="rounded-control border border-border bg-background px-2 py-1.5 text-xs"
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
      <p className="text-overline text-muted-foreground/60">yt-dlp engine</p>
      <div className="flex items-center justify-between gap-3 rounded-control border border-border bg-background/40 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2.5">
          {ok ? <CheckCircle2 className="size-4 shrink-0 text-success" /> : <AlertTriangle className="size-4 shrink-0 text-warning" />}
          <div className="min-w-0">
            <p className="text-xs font-medium">
              {status ? (status.version ? `Version ${status.version}` : 'Not detected') : 'Loading…'}
              {status && <span className="ml-1.5 text-[10px] text-muted-foreground/60">({status.managed ? 'auto-managed' : 'system'})</span>}
            </p>
            <p className="truncate text-[10px] text-muted-foreground/60">Last checked {checkedLabel} · auto-updates weekly</p>
          </div>
        </div>
        <Button
          onClick={checkNow}
          disabled={checking}
          variant="outline"
          size="sm"
          className="shrink-0 gap-1.5 text-xs"
        >
          {checking ? <Spinner size="sm" /> : <RefreshCw className="size-3.5" />}
          {checking ? 'Checking…' : 'Check now'}
        </Button>
      </div>
    </div>
  )
}

// ── Cookies file (age-gated / private video downloads) ────────────────────────────

interface CookiesStatus {
  present: boolean
  uploadedAt: number | null
}

function CookiesBlock() {
  const [status, setStatus] = useState<CookiesStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  async function load() {
    const r = await fetch('/api/youtube/admin/cookies', { credentials: 'include' })
    if (r.ok) setStatus(await r.json() as CookiesStatus)
  }
  useEffect(() => { load().catch(() => {}) }, [])

  async function upload(file: File) {
    setBusy(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const r = await fetch('/api/youtube/admin/cookies', { method: 'POST', credentials: 'include', body: formData })
      const data = await r.json() as CookiesStatus & { error?: string }
      if (!r.ok) { toast.error(data.error ?? 'Upload failed'); return }
      setStatus(data)
      toast.success('Cookies file uploaded')
    } catch { toast.error('Upload failed') } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function clear() {
    setBusy(true)
    try {
      const r = await fetch('/api/youtube/admin/cookies', { method: 'DELETE', credentials: 'include' })
      if (r.ok) setStatus(await r.json() as CookiesStatus)
    } catch { /* best-effort */ } finally { setBusy(false) }
  }

  const uploadedLabel = status?.uploadedAt ? new Date(status.uploadedAt).toLocaleString() : null

  return (
    <div className="space-y-2">
      <p className="text-overline text-muted-foreground/60">Cookies file</p>
      <div className="flex items-center justify-between gap-3 rounded-control border border-border bg-background/40 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2.5">
          {status?.present ? <CheckCircle2 className="size-4 shrink-0 text-success" /> : <AlertTriangle className="size-4 shrink-0 text-muted-foreground/60" />}
          <div className="min-w-0">
            <p className="text-xs font-medium">{status ? (status.present ? 'Configured' : 'Not configured') : 'Loading…'}</p>
            <p className="truncate text-[10px] text-muted-foreground/60">
              {uploadedLabel ? `Uploaded ${uploadedLabel}` : 'Export cookies.txt from a logged-in browser (e.g. "Get cookies.txt LOCALLY") to fix age-gated or private video downloads/exports. Not used for normal shared streaming.'}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <input ref={fileRef} type="file" accept=".txt" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) upload(f) }} />
          <Button onClick={() => fileRef.current?.click()} disabled={busy} variant="outline" size="sm" className="gap-1.5 text-xs">
            {busy ? <Spinner size="sm" /> : <Upload className="size-3.5" />}
            {status?.present ? 'Replace' : 'Upload'}
          </Button>
          {status?.present && (
            <Button onClick={clear} disabled={busy} variant="outline" size="sm" className="gap-1.5 text-xs">
              <X className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
