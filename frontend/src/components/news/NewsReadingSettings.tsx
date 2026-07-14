import { FileText, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useNewsReaderMode, type NewsReaderMode } from '@/hooks/useNewsReaderMode'

const OPTIONS: { value: NewsReaderMode; label: string; description: string; icon: typeof FileText }[] = [
  { value: 'reader', label: 'In-app reader', description: 'Opens a cleaned, cached version of the article right here.', icon: FileText },
  { value: 'external', label: 'Original site', description: 'Opens the article on its own site, in a new tab.', icon: ExternalLink },
]

// Personal, per-user preference for what clicking an article in News does. Stored via
// useNewsReaderMode (userPreferences key "news.reader_mode"); the article page's own
// "Open original" link is always available regardless of this default.
export function NewsReadingSettings() {
  const [mode, setMode] = useNewsReaderMode()

  return (
    <section className="max-w-xl space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Reading mode</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          What happens when you click an article in your feeds.
        </p>
      </div>

      <div className="space-y-2">
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => setMode(o.value)}
            className={cn(
              'flex w-full items-start gap-3 rounded-card border p-3 text-left transition-colors',
              mode === o.value ? 'border-brand/50 bg-brand/8' : 'border-border/60 bg-card/50 hover:bg-accent/30',
            )}
          >
            <o.icon className={cn('mt-0.5 size-4 shrink-0', mode === o.value ? 'text-brand' : 'text-muted-foreground')} />
            <div className="min-w-0">
              <div className="text-sm font-medium">{o.label}</div>
              <div className="text-xs text-muted-foreground">{o.description}</div>
            </div>
          </button>
        ))}
      </div>
    </section>
  )
}
