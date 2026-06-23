import { useEffect, useState } from 'react'
import { RefreshCw, Bell, Check } from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { Switch } from '@/components/ui/switch'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { updateItem, type ReaderItem } from '@/lib/reader/api'

const INTERVALS: { mins: number; label: string }[] = [
  { mins: 60, label: 'Hourly' },
  { mins: 360, label: 'Every 6 hours' },
  { mins: 1440, label: 'Daily' },
  { mins: 10080, label: 'Weekly' },
]
const DEFAULT_MINS = 1440

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

export function ReaderAutoUpdateMenu({ item, onChanged }: { item: ReaderItem; onChanged: () => void }) {
  const [autoUpdate, setAutoUpdate] = useState(item.autoUpdate)
  const [intervalMins, setIntervalMins] = useState(item.autoUpdateIntervalMins ?? DEFAULT_MINS)
  const [alertOnChange, setAlertOnChange] = useState(item.alertOnChange)
  const [saving, setSaving] = useState(false)

  // Re-sync when the item refetches (e.g. baseline archive completed).
  useEffect(() => {
    setAutoUpdate(item.autoUpdate)
    setIntervalMins(item.autoUpdateIntervalMins ?? DEFAULT_MINS)
    setAlertOnChange(item.alertOnChange)
  }, [item.autoUpdate, item.autoUpdateIntervalMins, item.alertOnChange])

  async function save(patch: Partial<{ autoUpdate: boolean; autoUpdateIntervalMins: number; alertOnChange: boolean }>) {
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

            <p className="mt-3 border-t border-border/50 pt-2 text-[11px] text-muted-foreground">
              Last checked {whenAgo(item.lastCheckedAt)}
              {item.contentChangedAt && <> · changed {whenAgo(item.contentChangedAt)}</>}
            </p>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
