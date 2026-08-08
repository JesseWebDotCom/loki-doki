import { useCardStyle, type CardStyle } from '@/hooks/useCardStyle'
import { cn } from '@/lib/cn'

const OPTIONS: { id: CardStyle; title: string; description: string }[] = [
  { id: 'modern', title: 'Modern', description: 'The Netflix look: a billboard hero leads the video home.' },
  { id: 'classic', title: 'Classic', description: "YouTube's look: the home starts straight with cards, each with its full channel line." },
  { id: 'classicMinimal', title: 'Classic Minimal', description: 'The classic cards with just the title, no channel or view counts.' },
]

// The card-style choice the iPhone and Apple TV apps share (hub client-prefs
// key "cardStyle"), so picking a style here restyles every signed-in device.
export function SettingsVideosAppearance() {
  const [style, setStyle] = useCardStyle()
  return (
    <div className="space-y-2">
      <p className="text-overline text-muted-foreground">Card style</p>
      <p className="text-[11px] text-muted-foreground/70 -mt-1">
        Synced with the iPhone and Apple TV apps - every device follows the same choice.
      </p>
      <div className="space-y-2">
        {OPTIONS.map((option) => (
          <button
            key={option.id} type="button" onClick={() => setStyle(option.id)}
            aria-pressed={style === option.id}
            className={cn('w-full rounded-card border px-4 py-3 text-left transition-colors',
              style === option.id ? 'border-brand/60 bg-brand/10' : 'border-border/60 hover:bg-accent/50')}
          >
            <span className="block text-sm font-semibold">{option.title}</span>
            <span className="block text-xs text-muted-foreground">{option.description}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
