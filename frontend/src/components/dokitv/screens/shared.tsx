// Shared building blocks for Doki TV page-channel screens. Every screen is a
// full-bleed ambient broadcast surface: dark, big type, 10-foot readable, and
// never interactive. Channel accent colors arrive at runtime, so they are the
// one sanctioned use of inline style here.

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { TvChannel } from '@/lib/dokitv/api'
import { cn } from '@/lib/cn'

// ── Fetch helpers ─────────────────────────────────────────────────────────────

export class HttpError extends Error {
  status: number
  constructor(status: number) {
    super(`Request failed with status ${status}`)
    this.status = status
  }
}

export async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { credentials: 'include' })
  if (!r.ok) throw new HttpError(r.status)
  return await r.json() as T
}

/** True when a request failed because the feature is disabled or gated (403/404). */
export function isFeatureOff(error: unknown): boolean {
  return error instanceof HttpError && (error.status === 403 || error.status === 404)
}

/** Retry policy for screens: never hammer a feature that is simply turned off. */
export function retryUnlessOff(failureCount: number, error: unknown): boolean {
  return !isFeatureOff(error) && failureCount < 2
}

// ── Time helpers ──────────────────────────────────────────────────────────────

/** Backend timestamps arrive as epoch ms or ISO strings depending on the route. */
export function toMs(value: number | string | null | undefined): number | null {
  if (value == null) return null
  if (typeof value === 'number') return value
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

export function clockLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function dateLabel(ms: number): string {
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function agoLabel(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60_000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** Re-render on a fixed cadence; returns the current epoch ms. */
export function useTick(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}

/** Cycle an index 0..count-1 on a timer; resets when the item count changes. */
export function useCycle(count: number, intervalMs: number): number {
  const [index, setIndex] = useState(0)
  useEffect(() => {
    setIndex(0)
    if (count <= 1) return
    const id = window.setInterval(() => setIndex((i) => (i + 1) % count), intervalMs)
    return () => window.clearInterval(id)
  }, [count, intervalMs])
  return count > 0 ? index % count : 0
}

// ── Channel accent styles (genuinely dynamic colors) ──────────────────────────

export function channelWash(channel: TvChannel): CSSProperties {
  return {
    backgroundImage: [
      `radial-gradient(120% 90% at 12% 0%, color-mix(in oklab, ${channel.colorDark} 42%, transparent) 0%, transparent 60%)`,
      `radial-gradient(110% 85% at 100% 100%, color-mix(in oklab, ${channel.color} 15%, transparent) 0%, transparent 62%)`,
    ].join(', '),
  }
}

export function channelBarStyle(channel: TvChannel): CSSProperties {
  return { backgroundImage: `linear-gradient(180deg, ${channel.color}, ${channel.colorDark})` }
}

export function channelPanelStyle(channel: TvChannel): CSSProperties {
  return {
    backgroundImage: `linear-gradient(135deg, color-mix(in oklab, ${channel.color} 38%, transparent), color-mix(in oklab, ${channel.colorDark} 60%, transparent))`,
  }
}

// ── Frame pieces ──────────────────────────────────────────────────────────────

interface ScreenEyebrowProps {
  channel: TvChannel
  title: string
  subtitle?: string | null
  right?: ReactNode
  className?: string
}

/** The program-title eyebrow every screen carries. */
export function ScreenEyebrow({ channel, title, subtitle, right, className }: ScreenEyebrowProps) {
  return (
    <div className={cn('flex min-w-0 items-center gap-3', className)}>
      <span aria-hidden className="h-5 w-1.5 shrink-0 rounded-full" style={channelBarStyle(channel)} />
      <span className="truncate text-sm font-bold uppercase tracking-[0.3em] text-foreground/80">{title}</span>
      {subtitle ? <span className="hidden truncate text-sm text-muted-foreground lg:inline">{subtitle}</span> : null}
      {right ? <div className="ml-auto flex shrink-0 items-center gap-3">{right}</div> : null}
    </div>
  )
}

interface ScreenFrameProps {
  channel: TvChannel
  title: string
  subtitle?: string | null
  right?: ReactNode
  className?: string
  children: ReactNode
}

/** Standard full-bleed frame: dark base, channel wash, eyebrow, content well. */
export function ScreenFrame({ channel, title, subtitle, right, className, children }: ScreenFrameProps) {
  return (
    <div data-theme="dark" className={cn('relative h-full w-full overflow-hidden bg-black text-foreground', className)}>
      <div aria-hidden className="absolute inset-0" style={channelWash(channel)} />
      <div className="relative z-10 flex h-full w-full flex-col gap-6 p-8 lg:p-10">
        <ScreenEyebrow channel={channel} title={title} subtitle={subtitle} right={right} />
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </div>
  )
}

interface StatusPanelProps {
  channel: TvChannel
  icon: LucideIcon
  headline: string
  note?: string
}

/** Calm branded panel for loading, empty, and error states. */
export function StatusPanel({ channel, icon: Icon, headline, note }: StatusPanelProps) {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="flex max-w-xl flex-col items-center gap-5 rounded-sheet border border-border/60 bg-card/50 px-14 py-12 text-center">
        <span className="flex size-16 items-center justify-center rounded-card" style={channelPanelStyle(channel)}>
          <Icon className="size-8" style={{ color: channel.color }} />
        </span>
        <p className="text-3xl font-bold tracking-tight">{headline}</p>
        {note ? <p className="text-lg text-muted-foreground">{note}</p> : null}
      </div>
    </div>
  )
}
