import { useEffect, useState } from 'react'
import { Check, Heart, Lock, Square, Volume2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useActiveCompanion, type CompanionRecord } from '@/hooks/useActiveCompanion'
import { isLocked } from '@/lib/companions/useCompanionStore'
import { formatGateReason } from '@/components/shared/contentDials'
import { speak, stopSpeech, useVoicePlaying } from '@/lib/voice/voicePlaybackStore'

/** Primary Select / Active / Locked button for a companion. */
export function SelectButton({ c, full, size = 'sm' }: { c: CompanionRecord; full?: boolean; size?: 'sm' | 'md' }) {
  const { activeCompanionId, setCompanion } = useActiveCompanion()
  const locked = isLocked(c)
  const active = c.id === activeCompanionId

  return (
    <Button
      type="button"
      size={size === 'md' ? 'default' : 'sm'}
      variant={locked ? 'secondary' : active ? 'tinted' : 'default'}
      disabled={locked}
      onClick={(e) => { e.stopPropagation(); if (!locked) setCompanion(c.id) }}
      className={cn(
        'font-semibold',
        full && 'w-full',
        // Keep the locked pill legible and non-transparent to clicks (disabled buttons
        // must swallow clicks so the surrounding card doesn't navigate).
        locked && 'disabled:pointer-events-auto disabled:opacity-100 cursor-not-allowed bg-foreground/5 text-muted-foreground',
      )}
    >
      {locked ? <><Lock className="size-3.5" /> Locked</> : active ? <><Check className="size-3.5" /> Active</> : 'Select'}
    </Button>
  )
}

/** Heart toggle to pin a companion as a favorite. */
export function FavoriteButton({ c, className }: { c: CompanionRecord; className?: string }) {
  const { isFavorite, toggleFavorite } = useActiveCompanion()
  const fav = isFavorite(c.id)
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      onClick={(e) => { e.stopPropagation(); toggleFavorite(c.id) }}
      aria-label={fav ? `Unfavorite ${c.name}` : `Favorite ${c.name}`}
      title={fav ? 'Remove from favorites' : 'Add to favorites'}
      className={cn('size-8 bg-background/70', className)}
    >
      <Heart className={cn('size-4', fav ? 'fill-brand text-brand' : 'text-muted-foreground')} />
    </Button>
  )
}

/** A short, character-agnostic line spoken in the companion's own voice for previews. */
export function companionPreviewLine(c: CompanionRecord): string {
  return `Hi, I'm ${c.name}. It's really nice to meet you.`
}

/**
 * Plays a canned greeting in the companion's voice. `variant='icon'` is the round
 * card button; `variant='pill'` is the labeled detail-page button. Toggles to a stop
 * control while its own utterance is playing.
 */
export function PreviewButton({ c, variant = 'icon', className }: { c: CompanionRecord; variant?: 'icon' | 'pill'; className?: string }) {
  const playing = useVoicePlaying()
  const [started, setStarted] = useState(false)
  const active = started && playing
  // Reset once global playback stops (our utterance finished or was superseded).
  useEffect(() => { if (!playing) setStarted(false) }, [playing])

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (active) { stopSpeech(); setStarted(false); return }
    setStarted(true)
    void speak({ text: companionPreviewLine(c), ttsVoice: c.ttsVoice, characterId: c.id, speechRate: c.speechRate ?? 1.0 })
      .catch(() => setStarted(false))
  }

  if (variant === 'pill') {
    return (
      <Button type="button" variant="secondary" onClick={onClick} className={cn('font-semibold', className)}>
        {active ? <Square className="size-4" /> : <Volume2 className="size-4" />}
        {active ? 'Stop' : 'Preview voice'}
      </Button>
    )
  }
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      onClick={onClick}
      aria-label={`Preview ${c.name}'s voice`}
      title="Preview voice"
      className={cn('size-8 bg-background/70', className)}
    >
      {active ? <Spinner className="text-brand" /> : <Volume2 className="size-4 text-muted-foreground" />}
    </Button>
  )
}

/** One-line human reason a locked companion can't be used (e.g. "explicit sexual"). */
export function lockReason(c: CompanionRecord): string {
  return c.gate && !c.gate.usable ? formatGateReason(c.gate.blockedBy) : ''
}
