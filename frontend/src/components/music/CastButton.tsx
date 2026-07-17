import { useCallback, useEffect, useState } from 'react'
import { Cast, Check, Speaker, X } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/cn'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { streamSrcForRef, artUrlForRef, parseTrackRef } from '@/lib/music/trackRef'
import { Spinner } from '@/components/ui/spinner'

interface CastDevice {
  id: string
  name: string
  model: string | null
}

interface CastButtonProps {
  /** Current track ref (bare YouTube id, local:<id>, or plex:<machineId>:<ratingKey>). */
  trackRef: string | null
  title: string
  artist: string | null
  /** Called when a cast starts, so the caller can pause local playback. */
  onCastStart?: () => void
}

const CONTENT_TYPES: Record<string, string> = {
  youtube: 'audio/mpeg',
  local: 'audio/mpeg',
  plex: 'audio/mpeg',
}

export function CastButton({ trackRef, title, artist, onCastStart }: CastButtonProps) {
  const [devices, setDevices] = useState<CastDevice[]>([])
  const [loading, setLoading] = useState(false)
  const [castingTo, setCastingTo] = useState<string | null>(null)
  const [busyDevice, setBusyDevice] = useState<string | null>(null)

  const loadDevices = useCallback(async (refresh = false) => {
    setLoading(true)
    try {
      const r = await fetch(`/api/cast/devices${refresh ? '?refresh=1' : ''}`, { credentials: 'include' })
      const data = await r.json() as { devices: CastDevice[] }
      setDevices(data.devices ?? [])
    } catch {
      toast.error('Could not find Cast devices')
    } finally {
      setLoading(false)
    }
  }, [])

  // Reflect an existing session (e.g. after a reload) so the button shows connected.
  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/cast/status', { credentials: 'include' })
        const data = await r.json() as { device?: { id: string } | null }
        if (data.device) setCastingTo(data.device.id)
      } catch { /* no session */ }
    })()
  }, [])

  async function castTo(device: CastDevice) {
    if (!trackRef) {
      toast.error('Nothing is playing to cast')
      return
    }
    setBusyDevice(device.id)
    try {
      const source = parseTrackRef(trackRef).source
      const streamPath = streamSrcForRef(trackRef)
      const artworkUrl = artUrlForRef(trackRef)
      const res = await fetch('/api/cast/cast', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: device.id,
          streamPath,
          contentType: CONTENT_TYPES[source] ?? 'audio/mpeg',
          title,
          subtitle: artist ?? '',
          artworkUrl,
        }),
      })
      const data = await res.json() as { ok: boolean; error?: string }
      if (!data.ok) {
        toast.error(data.error ?? 'Could not cast to that speaker')
        return
      }
      setCastingTo(device.id)
      onCastStart?.()
      toast.success(`Casting to ${device.name}`)
    } finally {
      setBusyDevice(null)
    }
  }

  async function stopCasting() {
    try {
      await fetch('/api/cast/control', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      })
    } catch { /* */ }
    setCastingTo(null)
    toast.success('Stopped casting')
  }

  return (
    <DropdownMenu onOpenChange={(open) => { if (open) void loadDevices() }}>
      <DropdownMenuTrigger asChild>
        <button
          aria-label="Cast to a speaker"
          className={cn(
            'inline-flex items-center justify-center rounded-full p-2 transition-colors',
            castingTo ? 'text-brand' : 'text-current/70 hover:text-current',
          )}
        >
          <Cast className="size-5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex items-center justify-between">
          <span>Play on</span>
          {loading && <Spinner className="size-3.5" />}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {castingTo && (
          <>
            <DropdownMenuItem onSelect={(e) => { e.preventDefault(); void stopCasting() }} className="text-destructive">
              <X className="size-4" /> Stop casting
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}

        {devices.length === 0 && !loading && (
          <div className="px-2 py-3 text-xs text-muted-foreground text-center">
            No Cast speakers found on your network.
          </div>
        )}

        {devices.map((device) => {
          const active = castingTo === device.id
          return (
            <DropdownMenuItem
              key={device.id}
              onSelect={(e) => { e.preventDefault(); if (!active) void castTo(device) }}
              className="flex items-center gap-2"
            >
              <Speaker className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{device.name}</div>
                {device.model && <div className="truncate text-xs text-muted-foreground">{device.model}</div>}
              </div>
              {busyDevice === device.id
                ? <Spinner className="size-4 shrink-0" />
                : active
                  ? <Check className="size-4 shrink-0 text-brand" />
                  : null}
            </DropdownMenuItem>
          )
        })}

        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={(e) => { e.preventDefault(); void loadDevices(true) }} className="text-xs text-muted-foreground justify-center">
          Refresh
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
