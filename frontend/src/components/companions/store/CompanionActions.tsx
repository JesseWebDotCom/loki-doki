import { useEffect, useState } from 'react'
import { Check, Heart, Lock, Loader2, Square, Volume2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useActiveCompanion, type CompanionRecord } from '@/hooks/useActiveCompanion'
import { isLocked } from '@/lib/companions/useCompanionStore'
import { formatGateReason } from '@/components/shared/contentDials'
import { speak, stopSpeech, useVoicePlaying } from '@/lib/voice/voicePlaybackStore'

/** Primary Select / Active / Locked button for a companion. */
export function SelectButton({ c, full, size = 'sm' }: { c: CompanionRecord; full?: boolean; size?: 'sm' | 'md' }) {
  const { activeCompanionId, setCompanion } = useActiveCompanion()
  const locked = isLocked(c)
  const active = c.id === activeCompanionId
  const pad = size === 'md' ? 'px-5 py-2 text-sm' : 'px-3 py-1.5 text-xs'

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); if (!locked) setCompanion(c.id) }}
      disabled={locked}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-full font-semibold transition-colors',
        pad,
        full && 'w-full',
        locked
          ? 'cursor-not-allowed bg-foreground/5 text-muted-foreground'
          : active
            ? 'bg-brand/15 text-brand'
            : 'bg-brand text-brand-foreground hover:bg-brand/90',
      )}
    >
      {locked ? <><Lock className="size-3.5" /> Locked</> : active ? <><Check className="size-3.5" /> Active</> : 'Select'}
    </button>
  )
}

/** Heart toggle to pin a companion as a favorite. */
export function FavoriteButton({ c, className }: { c: CompanionRecord; className?: string }) {
  const { isFavorite, toggleFavorite } = useActiveCompanion()
  const fav = isFavorite(c.id)
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); toggleFavorite(c.id) }}
      aria-label={fav ? `Unfavorite ${c.name}` : `Favorite ${c.name}`}
      title={fav ? 'Remove from favorites' : 'Add to favorites'}
      className={cn(
        'flex size-8 items-center justify-center rounded-full border border-border/40 bg-background/70 transition-colors hover:bg-accent',
        className,
      )}
    >
      <Heart className={cn('size-4', fav ? 'fill-rose-500 text-rose-500' : 'text-muted-foreground')} />
    </button>
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
      <button
        type="button"
        onClick={onClick}
        className={cn('inline-flex items-center justify-center gap-2 rounded-full bg-foreground/5 px-5 py-2 text-sm font-semibold transition-colors hover:bg-foreground/10', className)}
      >
        {active ? <Square className="size-4" /> : <Volume2 className="size-4" />}
        {active ? 'Stop' : 'Preview voice'}
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Preview ${c.name}'s voice`}
      title="Preview voice"
      className={cn('flex size-8 items-center justify-center rounded-full border border-border/40 bg-background/70 transition-colors hover:bg-accent', className)}
    >
      {active ? <Loader2 className="size-4 animate-spin text-brand" /> : <Volume2 className="size-4 text-muted-foreground" />}
    </button>
  )
}

/** One-line human reason a locked companion can't be used (e.g. "explicit sexual"). */
export function lockReason(c: CompanionRecord): string {
  return c.gate && !c.gate.usable ? formatGateReason(c.gate.blockedBy) : ''
}
