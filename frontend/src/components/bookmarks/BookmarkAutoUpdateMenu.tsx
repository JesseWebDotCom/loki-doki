import { useEffect, useState } from 'react'
import { RefreshCw, Bell, Check, Eye } from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { updateItem, type BookmarkItem, type WatchMode } from '@/lib/bookmarks/api'

const INTERVALS: { mins: number; label: string }[] = [
  { mins: 60, label: 'Hourly' },
  { mins: 360, label: 'Every 6 hours' },
  { mins: 1440, label: 'Daily' },
  { mins: 10080, label: 'Weekly' },
]
const DEFAULT_MINS = 1440

const WATCH_MODES: { value: WatchMode; label: string }[] = [
  { value: 'any_change', label: 'Anything changes' },
  { value: 'keyword_appears', label: 'A word appears…' },
  { value: 'keyword_disappears', label: 'A word disappears…' },
  { value: 'number_below', label: 'A number drops below…' },
  { value: 'number_above', label: 'A number rises above…' },
]

function whenAgo(iso: string | null): string {
  if (!iso) return 'never'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export function BookmarkAutoUpdateMenu({ item, onChanged }: { item: BookmarkItem; onChanged: () => void }) {
  const [autoUpdate, setAutoUpdate] = useState(item.autoUpdate)
  const [intervalMins, setIntervalMins] = useState(item.autoUpdateIntervalMins ?? DEFAULT_MINS)
  const [alertOnChange, setAlertOnChange] = useState(item.alertOnChange)
  const [watchPart, setWatchPart] = useState(!!item.watchSelector)
  const [selector, setSelector] = useState(item.watchSelector ?? '')
  const [watchMode, setWatchMode] = useState<WatchMode>(item.watchMode ?? 'any_change')
  const [keyword, setKeyword] = useState(item.watchKeyword ?? '')
  const [threshold, setThreshold] = useState(item.watchThreshold != null ? String(item.watchThreshold) : '')
  const [saving, setSaving] = useState(false)

  // Re-sync when the item refetches (e.g. baseline archive completed).
  useEffect(() => {
    setAutoUpdate(item.autoUpdate)
    setIntervalMins(item.autoUpdateIntervalMins ?? DEFAULT_MINS)
    setAlertOnChange(item.alertOnChange)
    setWatchPart(!!item.watchSelector)
    setSelector(item.watchSelector ?? '')
    setWatchMode(item.watchMode ?? 'any_change')
    setKeyword(item.watchKeyword ?? '')
    setThreshold(item.watchThreshold != null ? String(item.watchThreshold) : '')
  }, [item.autoUpdate, item.autoUpdateIntervalMins, item.alertOnChange, item.watchSelector, item.watchMode, item.watchKeyword, item.watchThreshold])

  async function save(patch: Partial<{
    autoUpdate: boolean; autoUpdateIntervalMins: number; alertOnChange: boolean
    watchSelector: string | null; watchMode: WatchMode; watchKeyword: string | null; watchThreshold: number | null
  }>) {
    setSaving(true)
    try {
      await updateItem(item.id, patch)
      onChanged()
    } catch {
      toast.error('Failed to update auto-update settings')
      // Roll local state back to the server's last-known values.
      setAutoUpdate(item.autoUpdate)
      setIntervalMins(item.autoUpdateIntervalMins ?? DEFAULT_MINS)
      setAlertOnChange(item.alertOnChange)
      setWatchPart(!!item.watchSelector)
      setSelector(item.watchSelector ?? '')
      setWatchMode(item.watchMode ?? 'any_change')
      setKeyword(item.watchKeyword ?? '')
      setThreshold(item.watchThreshold != null ? String(item.watchThreshold) : '')
    } finally {
      setSaving(false)
    }
  }

  function toggleAuto(next: boolean) {
    setAutoUpdate(next)
    void save({ autoUpdate: next })
    if (next) toast.success('Auto-update on — fetching a baseline…')
  }
  function pickInterval(mins: number) {
    setIntervalMins(mins)
    void save({ autoUpdateIntervalMins: mins })
  }
  function toggleAlert(next: boolean) {
    setAlertOnChange(next)
    void save({ alertOnChange: next })
  }
  function pickMode(mode: WatchMode) {
    setWatchMode(mode)
    void save({ watchMode: mode })
  }
  function toggleWatchPart(next: boolean) {
    setWatchPart(next)
    if (!next && item.watchSelector) { setSelector(''); void save({ watchSelector: null }) }
  }
  function commitSelector() {
    if ((selector.trim() || null) !== item.watchSelector) void save({ watchSelector: selector.trim() || null })
  }
  function commitKeyword() {
    if ((keyword.trim() || null) !== item.watchKeyword) void save({ watchKeyword: keyword.trim() || null })
  }
  function commitThreshold() {
    const n = threshold.trim() === '' ? null : Number(threshold)
    if (n !== null && !Number.isFinite(n)) return
    if (n !== item.watchThreshold) void save({ watchThreshold: n })
  }

  const needsKeyword = watchMode === 'keyword_appears' || watchMode === 'keyword_disappears'
  const needsNumber = watchMode === 'number_below' || watchMode === 'number_above'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          title="Auto-update"
          className={cn('inline-flex size-7 items-center justify-center rounded-md transition-colors hover:bg-accent',
            autoUpdate ? 'text-primary' : 'text-muted-foreground hover:text-foreground')}
        >
          <RefreshCw className={cn('size-4', autoUpdate && saving && 'animate-spin')} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72 p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Auto-update</p>
            <p className="text-xs text-muted-foreground">Periodically re-fetch this page.</p>
          </div>
          <Switch checked={autoUpdate} onCheckedChange={toggleAuto} />
        </div>

        {autoUpdate && (
          <>
            <div className="mt-3 border-t border-border/50 pt-3">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">Check every</p>
              <div className="grid gap-0.5">
                {INTERVALS.map((opt) => (
                  <button
                    key={opt.mins}
                    onClick={() => pickInterval(opt.mins)}
                    className={cn('flex items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent',
                      intervalMins === opt.mins ? 'text-foreground' : 'text-muted-foreground')}
                  >
                    {opt.label}
                    {intervalMins === opt.mins && <Check className="size-3.5 text-primary" />}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/50 pt-3">
              <div className="flex min-w-0 items-center gap-2">
                <Bell className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-sm font-medium">Alert on change</p>
                  <p className="text-xs text-muted-foreground">Notify me when the page changes.</p>
                </div>
              </div>
              <Switch checked={alertOnChange} onCheckedChange={toggleAlert} />
            </div>

            {alertOnChange && (
              <div className="mt-3 border-t border-border/50 pt-3">
                <div className="mb-1.5 flex items-center gap-1.5">
                  <Eye className="size-3.5 text-muted-foreground" />
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">Watch this page</p>
                </div>

                {/* What to watch */}
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="text-xs text-muted-foreground">Watch just part of the page</p>
                  <Switch checked={watchPart} onCheckedChange={toggleWatchPart} />
                </div>
                {watchPart && (
                  <div className="mb-2">
                    <Input
                      value={selector}
                      onChange={(e) => setSelector(e.target.value)}
                      onBlur={commitSelector}
                      onKeyDown={(e) => { if (e.key === 'Enter') commitSelector() }}
                      placeholder="#price or .stock-status"
                      className="h-8 font-mono text-xs"
                    />
                    <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
                      A CSS selector. On the site: right-click the part you care about → Inspect → copy its id (#…) or class (.…).
                    </p>
                  </div>
                )}

                {/* Alert when */}
                <p className="mb-1 text-xs text-muted-foreground">Alert me when</p>
                <div className="grid gap-0.5">
                  {WATCH_MODES.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => pickMode(opt.value)}
                      className={cn('flex items-center justify-between rounded-md px-2 py-1 text-sm transition-colors hover:bg-accent',
                        watchMode === opt.value ? 'text-foreground' : 'text-muted-foreground')}
                    >
                      {opt.label}
                      {watchMode === opt.value && <Check className="size-3.5 text-primary" />}
                    </button>
                  ))}
                </div>
                {needsKeyword && (
                  <Input
                    value={keyword}
                    onChange={(e) => setKeyword(e.target.value)}
                    onBlur={commitKeyword}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitKeyword() }}
                    placeholder={`word or phrase, e.g. "in stock"`}
                    className="mt-1.5 h-8 text-xs"
                  />
                )}
                {needsNumber && (
                  <Input
                    value={threshold}
                    onChange={(e) => setThreshold(e.target.value)}
                    onBlur={commitThreshold}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitThreshold() }}
                    placeholder="e.g. 500"
                    inputMode="decimal"
                    className="mt-1.5 h-8 text-xs"
                  />
                )}
              </div>
            )}

            <p className="mt-3 border-t border-border/50 pt-2 text-[11px] text-muted-foreground">
              Last checked {whenAgo(item.lastCheckedAt)}
              {item.contentChangedAt && <> · changed {whenAgo(item.contentChangedAt)}</>}
              {alertOnChange && item.lastWatchValue && (
                <span className="mt-1 block truncate" title={item.lastWatchValue}>
                  Watching: “{item.lastWatchValue.slice(0, 60)}{item.lastWatchValue.length > 60 ? '…' : ''}”
                </span>
              )}
            </p>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
