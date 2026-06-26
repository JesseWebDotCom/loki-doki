import { useEffect, useState } from 'react'
import { CalendarDays, CirclePlay, Headphones, Laugh, Loader2, Newspaper, PlaySquare, Trophy } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { useAuth } from '@/context/AuthContext'
import { resolveTickerConfig, type HomeLayout, type TickerConfig, type TickerSource } from '@/hooks/useHomeLayout'

export interface HomeHighlightPrefs {
  news: boolean
  onThisDay: boolean
  jokes: boolean
}

const DEFAULTS: HomeHighlightPrefs = { news: true, onThisDay: true, jokes: true }
const PREF_KEY = 'home.highlights'

const WIDGETS: {
  key: keyof HomeHighlightPrefs
  label: string
  description: string
  Icon: React.ElementType
}[] = [
  { key: 'news',      label: 'News',            description: 'Top local and global headlines',   Icon: Newspaper   },
  { key: 'onThisDay', label: 'On This Day',      description: 'Notable events in history today', Icon: CalendarDays },
  { key: 'jokes',     label: 'Joke of the Day',  description: 'A new dad joke every day',        Icon: Laugh       },
]

const TICKER_SOURCES: { key: TickerSource; label: string; description: string; Icon: React.ElementType }[] = [
  { key: 'sports',  label: 'Sports Scores',          description: 'Live scores and today\'s matchups',           Icon: Trophy     },
  { key: 'youtube', label: 'YouTube Subscriptions',  description: 'Latest uploads from subscribed channels',    Icon: PlaySquare },
  { key: 'news',    label: 'News Headlines',         description: 'Top stories from your news feeds',           Icon: Newspaper  },
  { key: 'podcast', label: 'Podcasts',               description: 'Recent AI-generated podcast episodes',       Icon: Headphones },
]

export function SettingsHomeTab() {
  const { user } = useAuth()
  const [prefs, setPrefs] = useState<HomeHighlightPrefs>(DEFAULTS)
  const [layout, setLayout] = useState<HomeLayout | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!user?.id) return
    fetch(`/api/users/${user.id}/preferences`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Record<string, unknown> | null) => {
        if (!data) return
        const saved = data[PREF_KEY]
        if (saved && typeof saved === 'object') {
          setPrefs({ ...DEFAULTS, ...(saved as Partial<HomeHighlightPrefs>) })
        }
      })
      .catch(() => {})
  }, [user?.id])

  useEffect(() => {
    fetch('/api/home-layout', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then((d: { layout?: HomeLayout } | null) => { if (d?.layout) setLayout(d.layout) })
      .catch(() => {})
  }, [])

  function toggle(key: keyof HomeHighlightPrefs) {
    if (!user?.id) return
    const next = { ...prefs, [key]: !prefs[key] }
    setPrefs(next)
    setSaving(true)
    fetch(`/api/users/${user.id}/preferences`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [PREF_KEY]: next }),
    })
      .finally(() => setSaving(false))
  }

  const tickerCfg = layout ? resolveTickerConfig(layout.header) : { enabled: true, sources: ['sports', 'youtube', 'news'] as TickerSource[] }

  async function saveTicker(cfg: TickerConfig) {
    if (!layout) return
    const next: HomeLayout = { ...layout, header: { ...layout.header, ticker: cfg } }
    setSaving(true)
    await fetch('/api/home-layout', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    }).finally(() => setSaving(false))
    setLayout(next)
  }

  function toggleTickerEnabled() {
    saveTicker({ ...tickerCfg, enabled: !tickerCfg.enabled })
  }

  function toggleTickerSource(key: TickerSource) {
    const sources = tickerCfg.sources.includes(key)
      ? tickerCfg.sources.filter(s => s !== key)
      : [...tickerCfg.sources, key]
    saveTicker({ ...tickerCfg, sources })
  }

  return (
    <div className="p-4 space-y-6">
      <div>
        <div className="flex items-center justify-between mb-1">
          <p className="text-sm font-medium">Today's Highlights</p>
          {saving && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          Choose which widgets appear on your home screen.
        </p>
        <div className="space-y-1">
          {WIDGETS.map(({ key, label, description, Icon }) => (
            <div
              key={key}
              className="flex items-center gap-4 rounded-xl px-3 py-3 hover:bg-muted/40 transition-colors"
            >
              <Icon className="size-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">{description}</p>
              </div>
              <Switch
                checked={prefs[key]}
                onCheckedChange={() => toggle(key)}
              />
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <CirclePlay className="size-4 text-muted-foreground" />
            <p className="text-sm font-medium">Ticker</p>
          </div>
          <div className="flex items-center gap-2">
            {saving && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
            <Switch checked={tickerCfg.enabled} onCheckedChange={toggleTickerEnabled} />
          </div>
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          A live scrolling bar across the top of your home screen.
        </p>
        {tickerCfg.enabled && (
          <div className="space-y-1">
            {TICKER_SOURCES.map(({ key, label, description, Icon }) => (
              <div
                key={key}
                className="flex items-center gap-4 rounded-xl px-3 py-3 hover:bg-muted/40 transition-colors"
              >
                <Icon className="size-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{label}</p>
                  <p className="text-xs text-muted-foreground">{description}</p>
                </div>
                <Switch
                  checked={tickerCfg.sources.includes(key)}
                  onCheckedChange={() => toggleTickerSource(key)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
