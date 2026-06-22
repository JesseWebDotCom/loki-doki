import { useMemo, useState } from 'react'
import { Globe, MapPin, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { RichOptionSelect, type RichOptionGroup } from '@/components/shared/RichOptionSelect'
import { useTimeApp } from '@/context/TimeAlarmContext'
import { useUserLocation } from '@/hooks/useUserLocation'
import { useNow } from '@/hooks/useNow'
import { zoneParts } from '@/lib/time/format'
import { TIMEZONES, tzLabel } from '@/lib/time/timezones'

const browserTimezone = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'UTC' }
})()

export function WorldClockTab() {
  const { locations, addLocation, removeLocation } = useTimeApp()
  // Home clock uses the same default location the rest of the app reads
  // (`user.location` preference — set in onboarding/settings, shared with maps,
  // briefing, chat tools). Falls back to the device timezone when unset.
  const { location } = useUserLocation()
  const home = {
    label: location?.displayName ?? location?.city ?? 'Local Time',
    timezone: location?.timezone ?? browserTimezone,
    pinned: !!location,
  }
  const now = useNow(1000)
  const nowDate = useMemo(() => new Date(now), [now])
  const homeParts = zoneParts(nowDate, home.timezone)

  const [addOpen, setAddOpen] = useState(false)
  const [tz, setTz] = useState('')
  const [label, setLabel] = useState('')
  const [deleteId, setDeleteId] = useState<string | null>(null)

  const tzGroups = useMemo<RichOptionGroup[]>(() => {
    const regions = [...new Set(TIMEZONES.map((t) => t.region))]
    return regions.map((region) => ({
      label: region,
      options: TIMEZONES.filter((t) => t.region === region).map((t) => ({ value: t.value, label: t.label, description: t.value })),
    }))
  }, [])

  function openAdd() { setTz(''); setLabel(''); setAddOpen(true) }
  async function handleAdd() {
    if (!tz) return
    await addLocation({ label: label.trim() || tzLabel(tz), timezone: tz })
    setAddOpen(false)
  }

  return (
    <div className="space-y-4">
      {/* Home clock — the user's default location (or device timezone). */}
      <div className="flex items-center justify-between rounded-2xl border border-brand/30 bg-brand/5 px-4 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-brand">
            <MapPin className="size-3.5" /> {home.pinned ? 'Home' : 'Local'}
          </div>
          <p className="truncate text-xl font-semibold">{home.label}</p>
          <p className="text-xs text-muted-foreground">{homeParts.dayLabel ? `${homeParts.dayLabel} · ` : ''}{homeParts.offset}</p>
        </div>
        <div className="text-right tabular-nums">
          <span className="text-4xl font-light tracking-tight">{homeParts.time}</span>
          <span className="ml-1 text-sm font-medium text-muted-foreground">{homeParts.ampm}</span>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Other cities</p>
        <Button size="sm" onClick={openAdd}><Plus className="size-4" /> Add city</Button>
      </div>

      {locations.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-border/60 bg-card/40 py-10 text-center">
          <Globe className="size-9 text-muted-foreground/60" />
          <p className="text-sm text-muted-foreground">Add a city to see its local time.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {locations.map((loc) => {
            const p = zoneParts(nowDate, loc.timezone)
            return (
              <div key={loc.id} className="group flex items-center justify-between rounded-2xl border border-border/60 bg-card px-4 py-3.5">
                <div className="min-w-0">
                  <p className="truncate text-lg font-semibold">{loc.label}</p>
                  <p className="text-xs text-muted-foreground">{p.dayLabel ? `${p.dayLabel} · ` : ''}{p.offset}</p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right tabular-nums">
                    <span className="text-3xl font-light tracking-tight">{p.time}</span>
                    <span className="ml-1 text-sm font-medium text-muted-foreground">{p.ampm}</span>
                  </div>
                  <button onClick={() => setDeleteId(loc.id)}
                    className="text-muted-foreground/0 transition-colors hover:text-destructive group-hover:text-muted-foreground"
                    aria-label="Remove city">
                    <Trash2 className="size-4" />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Add a city</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>City</Label>
              <RichOptionSelect value={tz} onChange={(v) => { setTz(v); if (!label) setLabel(tzLabel(v)) }} groups={tzGroups} placeholder="Choose a city…" />
            </div>
            <div className="space-y-1.5">
              <Label>Label (optional)</Label>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Home, Work" maxLength={80} />
            </div>
          </div>
          <DialogFooter className="mt-2">
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button onClick={() => void handleAdd()} disabled={!tz}>Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={(o) => { if (!o) setDeleteId(null) }}
        title="Remove this city?"
        description="It will no longer appear in your world clock."
        confirmLabel="Remove"
        destructive
        onConfirm={() => { if (deleteId) { void removeLocation(deleteId); setDeleteId(null) } }}
      />
    </div>
  )
}
