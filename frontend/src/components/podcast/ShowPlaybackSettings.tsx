import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Chip, ChipRow } from '@/components/shared/ChipRow'
import { usePodcastPlayback } from '@/context/PodcastPlaybackContext'
import { getShowSettings, saveShowSettings, DEFAULT_SHOW_SETTINGS, type ShowPlaybackSettings as Settings } from '@/lib/podcast/playerApi'

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2]
type TriState = boolean | null

function TriChips({ value, onChange }: { value: TriState; onChange: (v: TriState) => void }) {
  return (
    <ChipRow>
      <Chip label="Default" active={value === null} onClick={() => onChange(null)} />
      <Chip label="On" active={value === true} onClick={() => onChange(true)} />
      <Chip label="Off" active={value === false} onClick={() => onChange(false)} />
    </ChipRow>
  )
}

/** Per-show playback settings dialog: speed, intro/outro skip, and per-show overrides of
 *  the global trim-silence / voice-boost toggles. Applied automatically on play. */
export function ShowPlaybackSettings({ showId, showName, open, onOpenChange }: {
  showId: string
  showName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const { refreshShowSettings } = usePodcastPlayback()
  const { data: saved } = useQuery({
    queryKey: ['podcast-show-settings', showId],
    queryFn: () => getShowSettings(showId),
    enabled: open && !!showId,
  })

  const [form, setForm] = useState<Settings>({ ...DEFAULT_SHOW_SETTINGS })
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (open) setForm(saved ? { ...saved } : { ...DEFAULT_SHOW_SETTINGS })
  }, [open, saved])

  async function handleSave() {
    setSaving(true)
    try {
      await saveShowSettings(showId, form)
      qc.setQueryData(['podcast-show-settings', showId], form)
      refreshShowSettings(showId)
      toast.success('Playback settings saved.')
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save playback settings.')
    } finally {
      setSaving(false)
    }
  }

  const numField = (v: number, set: (n: number) => void) => (
    <Input
      type="number" min={0} max={600} value={v || ''}
      placeholder="0"
      onChange={e => set(Math.max(0, Math.min(600, Math.round(Number(e.target.value) || 0))))}
      className="w-24 text-right"
    />
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Playback settings</DialogTitle>
          <DialogDescription>Applied automatically whenever an episode of {showName} plays.</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div>
            <p className="mb-2 text-sm font-semibold">Speed</p>
            <ChipRow>
              <Chip label="Default" active={form.speed === null} onClick={() => setForm(f => ({ ...f, speed: null }))} />
              {SPEEDS.map(s => (
                <Chip key={s} label={`${s}x`} active={form.speed === s} onClick={() => setForm(f => ({ ...f, speed: s }))} />
              ))}
            </ChipRow>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold">Skip intro</p>
              <p className="text-xs text-muted-foreground">Seconds to jump past at the start.</p>
            </div>
            {numField(form.skipIntroSec, n => setForm(f => ({ ...f, skipIntroSec: n })))}
          </div>

          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold">Skip outro</p>
              <p className="text-xs text-muted-foreground">End the episode this many seconds early.</p>
            </div>
            {numField(form.skipOutroSec, n => setForm(f => ({ ...f, skipOutroSec: n })))}
          </div>

          <div>
            <p className="text-sm font-semibold">Trim silence</p>
            <p className="mb-2 text-xs text-muted-foreground">Override your global setting for this show.</p>
            <TriChips value={form.trimSilence} onChange={v => setForm(f => ({ ...f, trimSilence: v }))} />
          </div>

          <div>
            <p className="text-sm font-semibold">Voice boost</p>
            <p className="mb-2 text-xs text-muted-foreground">Override your global setting for this show.</p>
            <TriChips value={form.voiceBoost} onChange={v => setForm(f => ({ ...f, voiceBoost: v }))} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => void handleSave()} disabled={saving}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
