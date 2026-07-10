import { useEffect, useRef, useState } from 'react'
import { HardDriveDownload, Monitor, Smartphone } from 'lucide-react'
import { cn } from '@/lib/cn'
import { listDropDevices, sendFile, type DropDevice } from '@/lib/drop'
import { useForceIntercept } from '@/hooks/useHudMouseIntercept'

// Shelf page: drop files onto the island to send them to your other devices
// via the Drop system (lib/drop: sendFile multipart, null target = all my
// other devices).
//
// LIMITATION (by Electron design): OS file drags cannot wake a click-through
// window. setIgnoreMouseEvents(forward) forwards mousemove, NOT drag events,
// so a drop only lands while the panel is ALREADY open and intercepting. That
// is why this page force-holds interception while mounted (and IslandShell
// freezes dismissal on the shelf tab), and why click-to-browse is a co-equal
// path, not a fallback.

type SendState = { kind: 'idle' } | { kind: 'sending'; name: string } | { kind: 'sent'; name: string } | { kind: 'error'; message: string }

function deviceIcon(label: string) {
  return /iphone|android|mobile|ipad/i.test(label) ? Smartphone : Monitor
}

export function IslandPageShelf() {
  const [devices, setDevices] = useState<DropDevice[]>([])
  const [target, setTarget] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [state, setState] = useState<SendState>({ kind: 'idle' })
  const fileInputRef = useRef<HTMLInputElement>(null)

  // A live OS drag never triggers pointerenter, so the hover-intercept region
  // cannot arm in time; hold interception for the whole shelf session instead.
  useForceIntercept(true)

  useEffect(() => {
    let alive = true
    const tick = () => {
      void listDropDevices().then((d) => { if (alive) setDevices(d) }).catch(() => { /* offline */ })
    }
    tick()
    const t = setInterval(tick, 8000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  const send = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      setState({ kind: 'sending', name: file.name })
      try {
        const res = await sendFile(file, target)
        if (res.status === 409) {
          setState({ kind: 'error', message: 'That device is offline.' })
          return
        }
        if (!res.ok) {
          setState({ kind: 'error', message: `Could not send ${file.name}.` })
          return
        }
        setState({ kind: 'sent', name: file.name })
      } catch {
        setState({ kind: 'error', message: `Could not send ${file.name}.` })
        return
      }
    }
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {/* design-ok(glass-on-plain-bg): device chips inside the black island surface */}
        <button
          type="button"
          onClick={() => setTarget(null)}
          className={cn(
            'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
            target === null ? 'border-brand bg-brand/10 text-brand' : 'border-white/15 text-white/70 hover:text-white',
          )}
        >
          All my devices
        </button>
        {devices.map((d) => {
          const Icon = deviceIcon(d.label)
          return (
            // design-ok(glass-on-plain-bg): device chips inside the black island surface
            <button
              key={d.deviceId}
              type="button"
              onClick={() => setTarget(d.deviceId)}
              className={cn(
                'flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                target === d.deviceId ? 'border-brand bg-brand/10 text-brand' : 'border-white/15 text-white/70 hover:text-white',
              )}
            >
              <Icon className="size-3" />
              {d.label}
            </button>
          )
        })}
        {devices.length === 0 && <span className="text-[11px] text-white/40">No other devices online</span>}
      </div>

      <div
        role="button"
        tabIndex={0}
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(e) => { if (e.key === 'Enter') fileInputRef.current?.click() }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          if (e.dataTransfer.files.length) void send(e.dataTransfer.files)
        }}
        className={cn(
          'flex flex-1 cursor-pointer flex-col items-center justify-center gap-2 rounded-card border-2 border-dashed transition-colors',
          dragOver ? 'border-brand bg-brand/5' : 'border-white/20 hover:border-white/35',
        )}
      >
        <HardDriveDownload className={cn('size-7', dragOver ? 'text-brand' : 'text-white/45')} />
        <p className="text-sm text-white/75">Drop files here to send</p>
        <p className="text-[11px] text-white/40">or click to browse</p>
        {state.kind === 'sending' && <p className="text-[11px] text-white/60">Sending {state.name}…</p>}
        {state.kind === 'sent' && <p className="text-[11px] text-success">Sent {state.name}</p>}
        {state.kind === 'error' && <p className="text-[11px] text-destructive">{state.message}</p>}
      </div>

      {/* design-ok(raw-input-element): hidden file picker, no visual surface to style */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => { if (e.target.files?.length) void send(e.target.files); e.target.value = '' }}
      />
    </div>
  )
}
