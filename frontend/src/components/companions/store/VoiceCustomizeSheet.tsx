// Per-user companion voice customization (design: keen-percolating-swan). Lets a
// family member pick a different Kokoro voice, adjust speed/pitch, and toggle a
// hushed delivery for ONE companion, personal to them, never affecting other
// household members talking to the same companion. Saves to
// PUT /api/companions/:id/voice-prefs (backed by the generic userPreferences KV
// table; see backend/src/lib/voice/voicePrefs.ts).
import { useEffect, useState } from 'react'
import { Volume2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Spinner } from '@/components/ui/spinner'
import { VoicePicker } from '@/components/admin/voiceControls'
import { setVoicePitch } from '@/lib/voice/voicePlaybackStore'
import { toast } from '@/lib/toast'

interface VoicePrefs {
  voiceId?: string
  speechRate?: number
  pitchSemitones?: number
  hushed?: boolean
}

interface PrefsResponse {
  override: VoicePrefs
  effective: { voiceId: string | null; speechRate: number; pitchSemitones: number; hushed: boolean }
}

export function VoiceCustomizeButton({ characterId, characterName }: { characterId: string; characterName: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button type="button" variant="outline" size="icon" onClick={(e) => { e.stopPropagation(); setOpen(true) }} aria-label="Customize voice for me" title="Customize voice for me" className="size-8 bg-background/70">
        <Volume2 className="size-4" />
      </Button>
      {open && <VoiceCustomizeSheet characterId={characterId} characterName={characterName} open={open} onOpenChange={setOpen} />}
    </>
  )
}

function VoiceCustomizeSheet({ characterId, characterName, open, onOpenChange }: { characterId: string; characterName: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [voiceId, setVoiceIdState] = useState('') // '' = inherit the companion's default
  const [speechRate, setSpeechRate] = useState<number | null>(null) // null = inherit
  const [pitchSemitones, setPitchSemitonesState] = useState(0)
  const [hushed, setHushed] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/companions/${characterId}/voice-prefs`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: PrefsResponse | null) => {
        if (cancelled || !d) return
        setVoiceIdState(d.override.voiceId ?? '')
        setSpeechRate(d.override.speechRate ?? null)
        setPitchSemitonesState(d.override.pitchSemitones ?? 0)
        setHushed(d.override.hushed ?? false)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [characterId])

  const save = async () => {
    setSaving(true)
    try {
      const res = await fetch(`/api/companions/${characterId}/voice-prefs`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          voiceId: voiceId || null,
          speechRate,
          pitchSemitones,
          hushed,
        }),
      })
      if (!res.ok) throw new Error('save failed')
      // Pitch is client-side-only DSP (Kokoro has no native pitch param), so it's
      // applied to the live playback pipeline immediately rather than waiting for
      // the next page load.
      setVoicePitch(pitchSemitones)
      toast.success(`Voice preference saved for ${characterName}`)
      onOpenChange(false)
    } catch {
      toast.error('Could not save your voice preference. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-sm">
        <SheetTitle>Customize voice for me</SheetTitle>
        {loading ? (
          <div className="flex items-center justify-center py-10"><Spinner className="size-5" /></div>
        ) : (
          <div className="mt-4 flex flex-col gap-5 px-1">
            <p className="text-sm text-muted-foreground">
              This changes how {characterName} sounds only for you. No one else in your household is affected.
            </p>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Voice</label>
              <VoicePicker
                value={voiceId ? `kokoro:${voiceId.replace(/^kokoro:/, '')}` : ''}
                onChange={(v) => setVoiceIdState(v)}
                previewName={characterName}
                voicesEndpoint="/api/voice/voices"
              />
            </div>

            <div>
              <label className="mb-1.5 flex items-center justify-between text-xs font-medium text-muted-foreground">
                <span>Speed</span>
                <span className="tabular-nums">{speechRate == null ? 'Default' : `${speechRate.toFixed(2)}×`}</span>
              </label>
              <input type="range"
                min="0.8" max="1.3" step="0.05"
                value={speechRate ?? 1.0}
                onChange={(e) => setSpeechRate(Number(e.target.value))}
                className="w-full"
              />
            </div>

            <div>
              <label className="mb-1.5 flex items-center justify-between text-xs font-medium text-muted-foreground">
                <span>Pitch</span>
                <span className="tabular-nums">{pitchSemitones === 0 ? 'Default' : `${pitchSemitones > 0 ? '+' : ''}${pitchSemitones}`}</span>
              </label>
              <input type="range"
                min="-12" max="12" step="1"
                value={pitchSemitones}
                onChange={(e) => setPitchSemitonesState(Number(e.target.value))}
                className="w-full"
              />
              <p className="mt-1 text-caption text-muted-foreground/70">Applied in your browser only: pitch never changes on shared devices.</p>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Hushed delivery</p>
                <p className="text-caption text-muted-foreground/70">A quieter, gentler reply, good for late-night use.</p>
              </div>
              <Switch checked={hushed} onCheckedChange={setHushed} />
            </div>

            <Button type="button" onClick={() => void save()} disabled={saving} className="mt-2 w-full">
              {saving ? <Spinner className="size-4" /> : 'Save'}
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
