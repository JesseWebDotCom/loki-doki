import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Cast, Check, Laptop, Pause, Pencil, Play, SkipForward, Square, Volume2, X,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SeekBar } from '@/components/shared/SeekBar'
import { fmtClock } from '@/lib/youtube/format'
import { getDeviceId } from '@/lib/together/deviceIdentity'
import { listDevices, renameDevice, sendCommand, type TogetherCommand, type TogetherDevice } from '@/lib/together/api'

// Listening Together: the "phone as remote" surface. Lists every OTHER live player
// session in the household; picking one opens a compact remote (now-playing readout +
// transport + volume) that drives that session over the command channel. The chosen
// session executes everything through its own player contexts (TogetherRemoteReceiver),
// so this component never reaches into anyone's audio.
//
// Rendered from the music and podcast player bars. Polls while open only.

const POLL_MS = 5_000

function DeviceRow({ device, onPick }: { device: TogetherDevice; onPick: () => void }) {
  const state = device.state
  return (
    // design-ok(hand-styled-button): a selectable list row (art + two lines), not a
    // button-styled control - same anatomy as the Up Next rows in nowPlayingParts.
    <button
      onClick={onPick}
      className="flex w-full items-center gap-3 rounded-control px-2 py-2 text-left transition-colors hover:bg-foreground/[0.06]"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-control bg-foreground/8 text-muted-foreground">
        <Laptop className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{device.name}</span>
          {state?.playing && <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">Playing</Badge>}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {state ? `${state.title}${state.artist ? ` - ${state.artist}` : ''}` : `Idle - ${device.userName}`}
        </span>
      </span>
    </button>
  )
}

function RemoteSurface({ device, onBack, onRefetch }: {
  device: TogetherDevice
  onBack: () => void
  onRefetch: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(device.name)
  const state = device.state

  const cmd = useMutation({
    mutationFn: (c: TogetherCommand) => sendCommand(device.deviceId, c),
    onSuccess: (r) => {
      if (!r.delivered) toast.error(`${device.name} did not respond. Is the app still open there?`)
      else onRefetch()
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const rename = useMutation({
    mutationFn: (name: string) => renameDevice(device.deviceId, name),
    onSuccess: () => { setRenaming(false); toast.success('Device renamed'); onRefetch() },
    onError: (e: Error) => toast.error(e.message),
  })

  const send = (c: TogetherCommand) => cmd.mutate(c)
  const isMine = device.deviceId === getDeviceId()

  return (
    <div className="p-2">
      <div className="flex items-center gap-1 pb-2">
        <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back to devices" className="size-7">
          <X className="size-3.5" />
        </Button>
        {renaming ? (
          <form
            className="flex flex-1 items-center gap-1"
            onSubmit={(e) => { e.preventDefault(); if (draft.trim()) rename.mutate(draft.trim()) }}
          >
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Living Room TV"
              autoFocus
              className="h-7"
            />
            <Button type="submit" size="icon-sm" className="size-7" disabled={rename.isPending} aria-label="Save name">
              {rename.isPending ? <Spinner size="sm" /> : <Check className="size-3.5" />}
            </Button>
          </form>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{device.name}</span>
            {isMine && (
              <Button variant="ghost" size="icon-sm" onClick={() => { setDraft(device.name); setRenaming(true) }}
                className="size-7 text-muted-foreground" aria-label="Rename this device" title="Rename this device">
                <Pencil className="size-3.5" />
              </Button>
            )}
          </>
        )}
      </div>

      {/* Now playing readout */}
      <div className="rounded-control bg-foreground/[0.04] p-2.5">
        {state ? (
          <>
            <p className="truncate text-sm font-medium">{state.title}</p>
            <p className="truncate text-xs text-muted-foreground">{state.artist ?? 'Playing'}</p>
            <div className="mt-2">
              <SeekBar
                pos={state.positionSec}
                total={state.durationSec}
                onSeek={(sec) => send({ kind: 'seek', positionSec: sec })}
                disabled={state.durationSec <= 0}
              />
              <div className="mt-1 flex justify-between text-[10px] tabular-nums text-muted-foreground">
                <span>{fmtClock(state.positionSec)}</span>
                <span>{state.durationSec > 0 ? fmtClock(state.durationSec) : 'Live'}</span>
              </div>
            </div>
          </>
        ) : (
          <p className="py-2 text-center text-xs text-muted-foreground">Nothing playing there yet.</p>
        )}
      </div>

      {/* Transport */}
      <div className="mt-2 flex items-center justify-center gap-1">
        <Button variant="ghost" size="icon-sm" onClick={() => send({ kind: 'toggle' })}
          disabled={!state || cmd.isPending} aria-label={state?.playing ? 'Pause' : 'Play'}>
          {state?.playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current" />}
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => send({ kind: 'next' })}
          disabled={!state || cmd.isPending} aria-label="Next">
          <SkipForward className="size-4" />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => send({ kind: 'stop' })}
          disabled={!state || cmd.isPending} aria-label="Stop">
          <Square className="size-3.5" />
        </Button>
      </div>

      {/* Volume */}
      <div className="mt-2 flex items-center gap-2 px-1">
        <Volume2 className="size-3.5 shrink-0 text-muted-foreground" />
        {/* design-ok(raw-input-element): a range input has no keyboard, so no iOS focus zoom */}
        <input
          type="range" min={0} max={100} step={1}
          defaultValue={Math.round((state?.volume ?? 1) * 100)}
          onChange={(e) => send({ kind: 'volume', volume: Number(e.target.value) / 100 })}
          disabled={!state}
          aria-label="Volume"
          className="h-1 w-full cursor-pointer appearance-none rounded-full bg-foreground/15 accent-brand disabled:opacity-40"
        />
      </div>
    </div>
  )
}

export function DevicesPopover({ triggerClassName }: { triggerClassName?: string }) {
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const qc = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['together-devices'],
    queryFn: listDevices,
    enabled: open,
    refetchInterval: open ? POLL_MS : false,
  })

  const refetch = () => { void qc.invalidateQueries({ queryKey: ['together-devices'] }) }

  const me = getDeviceId()
  const others = (data?.devices ?? []).filter((d) => d.deviceId !== me)
  const mine = (data?.devices ?? []).find((d) => d.deviceId === me)
  const target = picked ? (data?.devices ?? []).find((d) => d.deviceId === picked) ?? null : null

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setPicked(null) }}>
      <PopoverTrigger asChild>
        <button
          className={triggerClassName ?? 'grid size-8 place-items-center rounded-full text-muted-foreground hover:text-foreground'}
          aria-label="Devices"
          title="Play on another device"
        >
          <Cast className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        {target ? (
          <RemoteSurface device={target} onBack={() => setPicked(null)} onRefetch={refetch} />
        ) : (
          <div className="p-1">
            <p className="px-2 pb-1 pt-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Devices
            </p>
            {isLoading && (
              <p className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
                <Spinner size="sm" /> Looking for devices…
              </p>
            )}
            {!isLoading && others.length === 0 && (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                No other devices are open right now. Open MaiPai Home on another screen to control it from here.
              </p>
            )}
            {others.map((d) => (
              <DeviceRow key={d.deviceId} device={d} onPick={() => setPicked(d.deviceId)} />
            ))}
            {mine && (
              <div className="mt-1 border-t border-border/60 pt-1">
                <button
                  onClick={() => setPicked(mine.deviceId)}
                  className={cn('flex w-full items-center gap-2 rounded-control px-2 py-2 text-left text-xs',
                    'text-muted-foreground transition-colors hover:bg-foreground/[0.06]')}
                >
                  <Laptop className="size-3.5 shrink-0" />
                  <span className="truncate">This device: {mine.name}</span>
                  <Pencil className="ml-auto size-3 shrink-0" />
                </button>
              </div>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
