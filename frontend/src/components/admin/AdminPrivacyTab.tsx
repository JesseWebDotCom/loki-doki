import { useCallback, useEffect, useRef, useState } from 'react'
import { Lock, Plus, RefreshCw, RotateCcw, Save, ShieldAlert, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { AdminAccordion } from '@/components/admin/AdminAccordion'
import { ContentProfilesManager } from '@/components/admin/ContentProfilesManager'

interface PrivacySettings {
  enabled: boolean
  timeoutSeconds: number
  hasPin: boolean
}

interface KeywordsData {
  keywords: string[]
  isCustom: boolean
  defaults: string[]
}

interface LoraRow {
  id: string
  name: string
  styleLabel: string | null
  isAdult: boolean
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
        checked ? 'bg-brand' : 'bg-muted',
      )}
    >
      <span
        className={cn(
          'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0',
        )}
      />
    </button>
  )
}

export function AdminPrivacyTab({ openSignal }: { openSignal?: string } = {}) {
  const [settings, setSettings] = useState<PrivacySettings | null>(null)
  const [loras, setLoras] = useState<LoraRow[]>([])
  const [keywordsData, setKeywordsData] = useState<KeywordsData | null>(null)
  const [pin, setPin] = useState('')
  const [pinConfirm, setPinConfirm] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [pinError, setPinError] = useState<string | null>(null)
  const [newKeyword, setNewKeyword] = useState('')
  const [kwSaving, setKwSaving] = useState(false)
  const [kwSaved, setKwSaved] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState<{ scanned: number; flagged: number } | null>(null)
  const kwInputRef = useRef<HTMLInputElement>(null)

  // "Saved!" badge timers, kept in refs so we can clear them on unmount
  // (and clear a previous one before scheduling a new one).
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const kwSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    if (kwSavedTimerRef.current) clearTimeout(kwSavedTimerRef.current)
  }, [])

  const load = useCallback((signal?: AbortSignal) => {
    const live = () => !signal?.aborted
    fetch('/api/privacy/admin/settings', { credentials: 'include', signal })
      .then(r => r.ok ? r.json() : null)
      .then((d: PrivacySettings | null) => { if (live() && d) setSettings(d) })
      .catch(() => {})

    fetch('/api/admin/image-loras', { credentials: 'include', signal })
      .then(r => r.ok ? r.json() : [])
      .then((d: LoraRow[]) => { if (live()) setLoras(Array.isArray(d) ? d : []) })
      .catch(() => {})

    fetch('/api/privacy/admin/keywords', { credentials: 'include', signal })
      .then(r => r.ok ? r.json() : null)
      .then((d: KeywordsData | null) => { if (live() && d) setKeywordsData(d) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    const ctrl = new AbortController()
    load(ctrl.signal)
    return () => ctrl.abort()
  }, [load])

  const saveSettings = async () => {
    if (!settings) return
    if (pin && pin !== pinConfirm) { setPinError('PINs do not match'); return }
    if (pin && pin.length < 4) { setPinError('PIN must be at least 4 characters'); return }
    setPinError(null)
    setSaving(true)
    try {
      const body: Record<string, unknown> = { enabled: settings.enabled, timeoutSeconds: settings.timeoutSeconds }
      if (pin) body.pin = pin
      const res = await fetch('/api/privacy/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'include',
      })
      if (res.ok) {
        const d = await res.json() as PrivacySettings
        setSettings(d); setPin(''); setPinConfirm('')
        setSaved(true)
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
        savedTimerRef.current = setTimeout(() => setSaved(false), 2000)
      }
    } finally { setSaving(false) }
  }

  const toggleLoraAdult = async (lora: LoraRow) => {
    const newVal = !lora.isAdult
    setLoras(prev => prev.map(l => l.id === lora.id ? { ...l, isAdult: newVal } : l))
    await fetch(`/api/admin/image-loras/${lora.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isAdult: newVal }),
      credentials: 'include',
    }).catch(() => {
      setLoras(prev => prev.map(l => l.id === lora.id ? { ...l, isAdult: lora.isAdult } : l))
    })
  }

  const addKeyword = () => {
    const kw = newKeyword.trim().toLowerCase()
    if (!kw || !keywordsData) return
    if (keywordsData.keywords.includes(kw)) { setNewKeyword(''); return }
    setKeywordsData(prev => prev ? { ...prev, keywords: [...prev.keywords, kw], isCustom: true } : prev)
    setNewKeyword('')
    kwInputRef.current?.focus()
  }

  const removeKeyword = (kw: string) => {
    setKeywordsData(prev => prev ? { ...prev, keywords: prev.keywords.filter(k => k !== kw), isCustom: true } : prev)
  }

  const saveKeywords = async () => {
    if (!keywordsData) return
    setKwSaving(true)
    try {
      const res = await fetch('/api/privacy/admin/keywords', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords: keywordsData.keywords }),
        credentials: 'include',
      })
      if (res.ok) {
        const d = await res.json() as KeywordsData
        setKeywordsData(d); setKwSaved(true)
        if (kwSavedTimerRef.current) clearTimeout(kwSavedTimerRef.current)
        kwSavedTimerRef.current = setTimeout(() => setKwSaved(false), 2000)
      }
    } finally { setKwSaving(false) }
  }

  const resetKeywords = async () => {
    const res = await fetch('/api/privacy/admin/keywords', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reset: true }),
      credentials: 'include',
    })
    if (res.ok) {
      const d = await res.json() as KeywordsData
      setKeywordsData(d)
    }
  }

  const runRescan = async () => {
    setScanning(true); setScanResult(null)
    try {
      const res = await fetch('/api/privacy/admin/rescan', { method: 'POST', credentials: 'include' })
      if (res.ok) {
        const d = await res.json() as { scanned: number; flagged: number }
        setScanResult(d)
        // Reload loras since flags may have changed
        fetch('/api/admin/image-loras', { credentials: 'include' })
          .then(r => r.ok ? r.json() : [])
          .then((d: LoraRow[]) => setLoras(Array.isArray(d) ? d : []))
          .catch(() => {})
      }
    } finally { setScanning(false) }
  }

  if (!settings) {
    return <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">Loading…</div>
  }

  return (
    <div className="space-y-3 p-5">
      {/* Content Profiles (replaces the old safety floor + instance ceiling) */}
      <ContentProfilesManager openSignal={openSignal} />

      {/* Privacy Mode */}
      <AdminAccordion id="privacy-mode" title="Privacy Mode"
        description="Hide adult styles and generated content behind a PIN (⌘⇧P)."
        openSignal={openSignal}>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">Enable privacy mode</label>
            <Toggle checked={settings.enabled} onChange={v => setSettings(s => s ? { ...s, enabled: v } : s)} />
          </div>

          <div className={cn('space-y-4', !settings.enabled && 'opacity-50 pointer-events-none')}>
            <div className="space-y-2">
              <label className="text-sm font-medium">Reveal timeout</label>
              <div className="flex items-center gap-3">
                <input type="number" min={10} max={3600} value={settings.timeoutSeconds}
                  onChange={e => setSettings(s => s ? { ...s, timeoutSeconds: Number(e.target.value) } : s)}
                  className="w-24 rounded-lg border border-border/60 bg-background px-3 py-1.5 text-sm outline-none focus:border-brand/60" />
                <span className="text-sm text-muted-foreground">seconds</span>
              </div>
            </div>

            <div className="h-px bg-border/40" />
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Lock className="size-3.5 text-muted-foreground" />
                <label className="text-sm font-medium">{settings.hasPin ? 'Change PIN' : 'Set PIN'}</label>
              </div>
              {settings.hasPin && <p className="text-xs text-muted-foreground">Leave blank to keep current PIN</p>}
              <input type="password" value={pin} onChange={e => { setPin(e.target.value); setPinError(null) }}
                placeholder="New PIN" autoComplete="new-password"
                className="w-full max-w-xs rounded-lg border border-border/60 bg-background px-3 py-1.5 text-sm outline-none focus:border-brand/60" />
              <input type="password" value={pinConfirm} onChange={e => { setPinConfirm(e.target.value); setPinError(null) }}
                placeholder="Confirm PIN" autoComplete="new-password"
                className="w-full max-w-xs rounded-lg border border-border/60 bg-background px-3 py-1.5 text-sm outline-none focus:border-brand/60" />
              {pinError && <p className="text-xs text-destructive">{pinError}</p>}
              {!settings.hasPin && !pin && (
                <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2 max-w-xs">
                  <ShieldAlert className="size-3.5 text-amber-500 mt-0.5 shrink-0" />
                  <p className="text-xs text-amber-700 dark:text-amber-400">Set a PIN to enable privacy mode.</p>
                </div>
              )}
            </div>
          </div>

          <button onClick={() => void saveSettings()} disabled={saving}
            className="flex items-center gap-2 rounded-lg bg-foreground px-3 py-2 text-sm font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-50">
            <Save className="size-3.5" />
            {saving ? 'Saving…' : saved ? 'Saved!' : 'Save settings'}
          </button>
        </div>
      </AdminAccordion>

      {/* Adult Detection Keywords */}
      {keywordsData && (
        <AdminAccordion id="adult-keywords" title="Adult Detection Keywords"
          description="Scanned at LoRA import time to auto-flag adult styles."
          openSignal={openSignal}>
          <div className="space-y-2">
            {keywordsData.isCustom && (
              <div className="flex justify-end">
                <button onClick={() => void resetKeywords()}
                  className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                  <RotateCcw className="size-3" /> Reset to defaults
                </button>
              </div>
            )}
            <div className="flex gap-2">
              <input
                ref={kwInputRef}
                type="text"
                value={newKeyword}
                onChange={e => setNewKeyword(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addKeyword() } }}
                placeholder="Add keyword…"
                className="flex-1 rounded-lg border border-border/60 bg-background px-3 py-1.5 text-sm outline-none focus:border-brand/60"
              />
              <button onClick={addKeyword}
                className="flex items-center gap-1 rounded-lg bg-muted px-3 py-1.5 text-sm font-medium hover:bg-muted/80 transition-colors">
                <Plus className="size-3.5" /> Add
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
              {keywordsData.keywords.map(kw => (
                <span key={kw} className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs text-foreground">
                  {kw}
                  <button onClick={() => removeKeyword(kw)}
                    className="text-muted-foreground hover:text-destructive transition-colors">
                    <X className="size-2.5" />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex items-center gap-2 pt-1">
              <button onClick={() => void saveKeywords()} disabled={kwSaving}
                className="flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 text-xs font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-50">
                <Save className="size-3" />
                {kwSaving ? 'Saving…' : kwSaved ? 'Saved!' : 'Save keywords'}
              </button>
              <p className="text-xs text-muted-foreground">{keywordsData.keywords.length} keywords</p>
            </div>
          </div>
        </AdminAccordion>
      )}

      {/* Style Adult Flags */}
      <AdminAccordion id="lora-flags" title="Style Adult Flags"
        description="Re-scan installed styles and manually mark them adult."
        openSignal={openSignal}>
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <button onClick={() => void runRescan()} disabled={scanning}
              className="flex items-center gap-2 rounded-lg border border-border/60 bg-card px-3 py-2 text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50">
              <RefreshCw className={cn('size-3.5', scanning && 'animate-spin')} />
              {scanning ? 'Scanning…' : 'Re-scan all LoRAs'}
            </button>
            {scanResult && (
              <p className="text-xs text-muted-foreground">
                {scanResult.scanned} scanned — {scanResult.flagged} flagged
              </p>
            )}
          </div>

          {loras.length > 0 ? (
            <div className="rounded-xl border border-border/50 divide-y divide-border/30 overflow-hidden">
              {loras.map(lora => (
                <div key={lora.id} className="flex items-center justify-between px-4 py-2.5 bg-card">
                  <span className="text-sm text-foreground">{lora.styleLabel ?? lora.name}</span>
                  <Toggle checked={lora.isAdult} onChange={() => void toggleLoraAdult(lora)} />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No styles installed yet.</p>
          )}
        </div>
      </AdminAccordion>
    </div>
  )
}
