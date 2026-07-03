import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { RichOptionSelect } from '@/components/shared/RichOptionSelect'
import { cn } from '@/lib/cn'
import { createStation, updateStation, type Station, type DjMode } from '@/lib/music/catalogApi'
import { stationGradient } from '@/components/music/StationCard'

const ACCENTS = ['violet', 'blue', 'cyan', 'emerald', 'amber', 'rose', 'fuchsia', 'slate']
const DJ_OPTIONS = [{
  options: [
    { value: 'full', label: 'Full DJ', description: 'An AI host talks between songs' },
    { value: 'minimal', label: 'DJ minimal', description: 'Just announces each song' },
    { value: 'silent', label: 'Silent', description: 'No DJ, just the music' },
  ],
}]

export function StationEditorDialog({ open, onOpenChange, station }: {
  open: boolean; onOpenChange: (o: boolean) => void; station: Station | null
}) {
  const qc = useQueryClient()
  const editing = !!station
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [aiPrompt, setAiPrompt] = useState('')
  const [djMode, setDjMode] = useState<DjMode>('full')
  const [accent, setAccent] = useState('violet')
  const [shared, setShared] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(station?.name ?? '')
    setDescription(station?.description ?? '')
    setAiPrompt(station?.aiPrompt ?? '')
    setDjMode(station?.djMode ?? 'full')
    setAccent(station?.accent ?? 'violet')
    setShared(station?.visibility === 'shared')
  }, [open, station])

  const save = async () => {
    if (!name.trim()) { toast.error('Give your station a name'); return }
    if (!aiPrompt.trim()) { toast.error('Describe what the station should play'); return }
    setSaving(true)
    try {
      const payload = { name: name.trim(), description: description.trim(), aiPrompt: aiPrompt.trim(), djMode, accent, visibility: shared ? 'shared' as const : 'private' as const }
      if (editing) await updateStation(station!.id, payload)
      else await createStation(payload)
      await qc.invalidateQueries({ queryKey: ['music-stations'] })
      toast.success(editing ? 'Station updated' : 'Station created')
      onOpenChange(false)
    } catch {
      toast.error('Could not save the station')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{editing ? 'Edit station' : 'New station'}</DialogTitle></DialogHeader>
        <DialogDescription className="sr-only">Set up your AI radio station's name, prompt, and options.</DialogDescription>
        <div className="space-y-4">
          <div>
            <Label className="mb-1.5 block text-xs">Name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="Late Night Drive" />
          </div>
          <div>
            <Label className="mb-1.5 block text-xs">Description</Label>
            <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="Moody synthwave for empty highways" />
          </div>
          <div>
            <Label className="mb-1.5 block text-xs">What should it play?</Label>
            <Textarea value={aiPrompt} onChange={e => setAiPrompt(e.target.value)} rows={3}
              placeholder="80s synthwave and darkwave, instrumental-leaning, moody and atmospheric. No big radio hits." />
            <p className="mt-1 text-[11px] text-muted-foreground">The AI builds a fresh queue from this each time you tune in.</p>
          </div>
          <div>
            <Label className="mb-1.5 block text-xs">DJ</Label>
            <RichOptionSelect groups={DJ_OPTIONS} value={djMode} onChange={v => setDjMode(v as DjMode)} />
          </div>
          <div>
            <Label className="mb-1.5 block text-xs">Color</Label>
            <div className="flex gap-2">
              {ACCENTS.map(a => (
                <button key={a} type="button" onClick={() => setAccent(a)}
                  className={cn('size-7 rounded-full ring-2 ring-offset-2 ring-offset-background transition',
                    accent === a ? 'ring-foreground' : 'ring-transparent hover:ring-border')}
                  style={{ background: stationGradient(a) }} aria-label={a} />
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between rounded-control border border-border/60 px-3 py-2.5">
            <div>
              <p className="text-sm font-medium">Share with the family</p>
              <p className="text-[11px] text-muted-foreground">Everyone can play it; only you can edit it.</p>
            </div>
            <Switch checked={shared} onCheckedChange={setShared} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : editing ? 'Save' : 'Create station'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
