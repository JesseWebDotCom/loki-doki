// Modal to choose a separation layout before generating stems (Moises-style): quick Presets,
// or Custom to pick exactly which instruments to isolate. When the RoFormer guitar model is
// installed, Guitar is badged "Enhanced".
import { useState } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { MODEL_OPTIONS, CUSTOM_STEMS, stemInfo } from './stemMeta'
import type { StemModel, CustomStem } from '@/lib/music/studioApi'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onGenerate: (req: { model?: StemModel; stems?: CustomStem[]; enhancedGuitar?: boolean }) => void
  guitarEnhanced?: boolean
}

export function StemOptionsSheet({ open, onOpenChange, onGenerate, guitarEnhanced }: Props) {
  // Default to Custom so the instrument picker (incl. Guitar) is visible up front.
  const [tab, setTab] = useState<'presets' | 'custom'>('custom')
  const [preset, setPreset] = useState<StemModel>('6-stem')
  const [picked, setPicked] = useState<Set<CustomStem>>(new Set(['vocals', 'drums', 'bass', 'guitar']))
  const [enhanced, setEnhanced] = useState(true)

  const toggle = (name: CustomStem) => setPicked((prev) => {
    const next = new Set(prev)
    next.has(name) ? next.delete(name) : next.add(name)
    return next
  })

  // The Enhanced Guitar toggle only matters when the request includes a guitar stem.
  const hasGuitar = tab === 'custom' ? picked.has('guitar') : preset === '6-stem'

  function generate() {
    // Only meaningful when guitar is in the set AND the RoFormer add-on is installed.
    const enhancedGuitar = hasGuitar && guitarEnhanced ? enhanced : undefined
    if (tab === 'custom') { if (picked.size === 0) return; onGenerate({ stems: [...picked], enhancedGuitar }) }
    else onGenerate({ model: preset, enhancedGuitar })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Separate into stems</DialogTitle>
          <DialogDescription>Pick a preset, or choose exactly which instruments to isolate.</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-1 rounded-control bg-muted p-1">
          {(['presets', 'custom'] as const).map((t) => (
            <Button key={t} variant={tab === t ? 'default' : 'ghost'} size="sm" onClick={() => setTab(t)} className="capitalize">{t}</Button>
          ))}
        </div>

        {tab === 'presets' ? (
          <div className="space-y-2 py-1">
            {MODEL_OPTIONS.map((opt) => {
              const active = preset === opt.model
              return (
                <Button
                  key={opt.model} variant="secondary" onClick={() => setPreset(opt.model)} aria-pressed={active}
                  className={cn('h-auto w-full flex-col items-start gap-0.5 whitespace-normal px-4 py-3 text-left', active && 'bg-brand/15 ring-2 ring-brand')}
                >
                  <span className="text-sm font-semibold text-foreground">{opt.label}</span>
                  <span className="text-xs font-normal text-muted-foreground">{opt.tracks}</span>
                </Button>
              )
            })}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 py-1">
            {CUSTOM_STEMS.map(({ name, label }) => {
              const on = picked.has(name)
              const Icon = stemInfo(name).icon
              return (
                <Button
                  key={name} variant="secondary" onClick={() => toggle(name)} aria-pressed={on}
                  className={cn('h-auto justify-start gap-2 px-3 py-2.5', on && 'bg-brand/15 ring-2 ring-brand')}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="flex-1 text-left text-sm font-medium">{label}</span>
                  {name === 'guitar' && guitarEnhanced && <span className="rounded-full bg-brand/20 px-1.5 py-0.5 text-[10px] font-semibold text-brand">Enhanced</span>}
                  {on && <Check className="size-4 shrink-0 text-brand" />}
                </Button>
              )
            })}
          </div>
        )}

        {hasGuitar && (
          <label className={cn('flex items-center gap-2 rounded-control bg-card/60 px-3 py-2 text-sm', guitarEnhanced ? 'cursor-pointer' : 'opacity-70')}>
            <input type="checkbox" disabled={!guitarEnhanced} checked={guitarEnhanced && enhanced}
              onChange={(e) => setEnhanced(e.target.checked)} className="size-4 cursor-pointer accent-primary disabled:cursor-not-allowed" />
            <span className="flex-1 text-foreground">Enhanced guitar stemming</span>
            <span className="text-xs text-muted-foreground">{guitarEnhanced ? 'cleaner, slower' : 'add-on not installed'}</span>
          </label>
        )}

        <DialogFooter>
          <Button className="w-full" onClick={generate} disabled={tab === 'custom' && picked.size === 0}>
            Generate AI Stems
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
