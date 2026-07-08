// "Configure for offline" - the one per-creator offline mechanism, shared by the YouTube
// channel page and every generic-source creator page. Rules-based, not one-shot: enabling
// it immediately backfills the creator's latest N videos AND keeps the window rolling
// (auto-save new uploads, prune to keep-N, optionally delete once watched). All rows it
// creates are auto:true, so the keep-N prune governs them from day one; manual per-video
// saves are never touched by any of these rules.

import { useState } from 'react'
import { HardDriveDownload } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { toast } from '@/lib/toast'

export interface OfflinePolicy {
  autoSave: boolean
  autoSaveKind: 'audio' | 'video'
  autoSaveKeep: number | null
  removeWatched: boolean
}

interface ConfigureOfflinePopoverProps {
  /** null = not subscribed yet - the popover only shows a "subscribe first" hint. */
  policy: OfflinePolicy | null
  /** Provider capabilities; hides the format toggle when only one kind is available. */
  downloadKinds: ReadonlyArray<'audio' | 'video'>
  /** Placeholder/effective keep-N when the policy doesn't override it. */
  keepDefault?: number
  onPatch: (patch: Partial<OfflinePolicy>) => void | Promise<void>
  /** Back-catalogue backfill, called with auto:true semantics when the rules are enabled. */
  onBackfill: (opts: { kind: 'audio' | 'video'; count: number }) => Promise<{ queued?: number; error?: string }>
}

export function ConfigureOfflinePopover({ policy, downloadKinds, keepDefault = 10, onPatch, onBackfill }: ConfigureOfflinePopoverProps) {
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [backfilling, setBackfilling] = useState(false)
  const on = !!policy?.autoSave
  const kind = policy?.autoSaveKind ?? (downloadKinds.includes('video') ? 'video' : 'audio')
  const keep = policy?.autoSaveKeep ?? null
  const effectiveKeep = keep && keep > 0 ? keep : keepDefault

  async function enable() {
    await onPatch({ autoSave: true })
    setBackfilling(true)
    try {
      const r = await onBackfill({ kind, count: effectiveKeep })
      if (r.error) { toast.error(r.error); return }
      toast.success(`Keeping the latest ${effectiveKeep} ${kind === 'audio' ? 'tracks' : 'videos'} offline`)
    } catch {
      toast.error('Rules saved, but the initial download could not start')
    } finally { setBackfilling(false) }
  }

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <Button size="icon"
            aria-label="Configure for offline"
            title={on ? `Keeping the latest ${effectiveKeep} ${policy!.autoSaveKind} offline` : 'Configure for offline'}
            className={cn('size-10',
              on ? 'bg-[var(--yt-accent)] text-white hover:bg-[var(--yt-accent-hover)]' : 'bg-muted text-muted-foreground hover:bg-muted hover:text-foreground')}>
            <HardDriveDownload className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 space-y-3 p-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Keep this creator offline</p>
              <p className="text-xs text-muted-foreground">
                Downloads the latest uploads automatically and keeps them current.
              </p>
            </div>
            <Switch checked={on} disabled={!policy || backfilling}
              onCheckedChange={v => { if (v) void enable(); else void onPatch({ autoSave: false }) }} />
          </div>

          {!policy && (
            <p className="border-t border-border/50 pt-3 text-xs text-muted-foreground">
              Subscribe first - offline rules live on the subscription.
            </p>
          )}

          {policy && on && (
            <div className="space-y-3 border-t border-border/50 pt-3">
              {downloadKinds.length > 1 && (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-muted-foreground">Save as</span>
                  <div className="flex overflow-hidden rounded-full border border-border">
                    {(['video', 'audio'] as const).filter(k => downloadKinds.includes(k)).map(k => (
                      <button key={k} onClick={() => void onPatch({ autoSaveKind: k })}
                        className={cn('px-3 py-1 text-xs font-medium capitalize transition-colors',
                          policy.autoSaveKind === k ? 'bg-[var(--yt-accent)] text-white' : 'bg-background text-muted-foreground hover:text-foreground')}>
                        {k}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-muted-foreground">Keep last</span>
                <div className="flex items-center gap-1.5">
                  <input type="number" min={0} value={keep ?? ''} placeholder={String(keepDefault)}
                    onChange={e => void onPatch({ autoSaveKeep: e.target.value === '' ? null : Math.max(0, Math.floor(Number(e.target.value))) })}
                    className="w-16 rounded-control border border-border bg-background px-2 py-1 text-sm" />
                  <span className="text-xs text-muted-foreground">videos</span>
                </div>
              </div>
              <p className="-mt-2 text-[11px] text-muted-foreground/70">Older auto-saved videos roll off. 0 = keep everything.</p>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Remove once watched</p>
                  <p className="text-xs text-muted-foreground">Delete a copy after you finish it.</p>
                </div>
                <Switch checked={policy.removeWatched}
                  onCheckedChange={v => { if (v) setConfirmRemove(true); else void onPatch({ removeWatched: false }) }} />
              </div>
            </div>
          )}
        </PopoverContent>
      </Popover>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove watched videos?"
        description="Auto-saved videos from this creator will be deleted from Offline within about an hour of you finishing them - including any you've already watched. Videos you saved yourself are never removed."
        confirmLabel="Remove once watched"
        destructive
        onConfirm={() => void onPatch({ removeWatched: true })}
      />
    </>
  )
}
