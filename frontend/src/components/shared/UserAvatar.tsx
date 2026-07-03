import { useMemo } from 'react'
import { createAvatar } from '@dicebear/core'
import { avataaars, bottts, toonHead } from '@dicebear/collection'
import { coerceStyle } from '@/components/companion/styles'
import type { HeadTiltState } from '@/components/companion/useHeadTilt'
import { faceForState } from '@/components/companion/faceForState'
import { filterOptionsForStyle } from '@/components/companion/dicebearSchema'
import { defaultEyeFor } from '@/components/companion/visemeMap'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'
import AngryFlames from '@/components/companion/AngryFlames'
import SleepingZs from '@/components/companion/SleepingZs'
import ThinkingDots from '@/components/companion/ThinkingDots'

const STYLE_MAP = { avataaars, bottts, 'toon-head': toonHead } as const

// Per-user fallback avatar colors: identity data (a stable hash of the user id picks one),
// deliberately varied rather than brand-tinted so users stay distinguishable.
const GRADIENTS = [
  // design-ok(banned-palette) design-ok(raw-palette-semantic): per-user avatar identity palette data
  'from-violet-600 to-blue-500',
  // design-ok(raw-palette-semantic): per-user avatar identity palette data
  'from-pink-600 to-rose-500',
  // design-ok(raw-palette-semantic): per-user avatar identity palette data
  'from-emerald-600 to-teal-500',
  // design-ok(raw-palette-semantic): per-user avatar identity palette data
  'from-amber-500 to-orange-500',
  // design-ok(raw-palette-semantic): per-user avatar identity palette data
  'from-sky-600 to-cyan-500',
  // design-ok(banned-palette): per-user avatar identity palette data
  'from-fuchsia-600 to-purple-500',
]

function gradientFor(id: string) {
  const idx = id.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % GRADIENTS.length
  return GRADIENTS[idx]
}

export interface UserAvatarUser {
  id: string
  firstName: string
  lastName: string
  avatarUrl?: string | null
  dicebearStyle?: string | null
  dicebearSeed?: string | null
  // Accepts both a parsed object (from AuthContext) and a raw JSON string (from admin API)
  dicebearConfig?: Record<string, unknown> | string | null
}

interface UserAvatarProps {
  user: UserAvatarUser
  size?: number
  className?: string
}

function DicebearSnapshot({ user, size, className }: { user: UserAvatarUser; size: number; className?: string }) {
  const result = useMemo(() => {
    const style = coerceStyle(user.dicebearStyle)

    let cfg: Record<string, unknown> = {}
    if (typeof user.dicebearConfig === 'string') {
      try { cfg = JSON.parse(user.dicebearConfig) as Record<string, unknown> } catch { /* */ }
    } else if (user.dicebearConfig) {
      cfg = { ...user.dicebearConfig }
    }

    const pose = (cfg._pose as HeadTiltState | undefined) ?? 'listening'
    const expr = faceForState(pose, style)

    const opts: Record<string, unknown> = { ...cfg }
    delete opts._pose  // internal key, not a DiceBear option

    const userSetMouth    = 'mouth'    in opts
    const userSetEyes     = 'eyes'     in opts
    const userSetEyebrows = 'eyebrows' in opts

    if (expr?.mouth && !userSetMouth) {
      opts.mouth = [expr.mouth]
      opts.mouthProbability = 100
    }
    if (expr?.eyes && !userSetEyes) {
      opts.eyes = [expr.eyes]
      opts.eyesProbability = 100
    } else if (defaultEyeFor(style) && !userSetEyes) {
      opts.eyes = [defaultEyeFor(style) as string]
      opts.eyesProbability = 100
    }
    if (expr?.eyebrows && !userSetEyebrows) {
      opts.eyebrows = [expr.eyebrows]
      opts.eyebrowsProbability = 100
    }

    const filtered = filterOptionsForStyle(style, opts)
    const svg = createAvatar(STYLE_MAP[style], { seed: user.dicebearSeed ?? 'default', ...filtered }).toString()
    return { dataUrl: `data:image/svg+xml,${encodeURIComponent(svg)}`, pose }
  }, [user.dicebearStyle, user.dicebearSeed, user.dicebearConfig])

  const sizeStyle = !className?.includes('h-') ? { width: size, height: size } : undefined

  return (
    <div
      className={cn('relative overflow-hidden shrink-0', className)}
      style={{ containerType: 'size', ...sizeStyle }}
    >
      <img src={result.dataUrl} alt="" className="w-full h-full object-cover" />
      {result.pose === 'angry'    && <AngryFlames />}
      {result.pose === 'thinking' && <ThinkingDots tiltDeg={0} />}
      {result.pose === 'sleeping' && <SleepingZs tiltDeg={0} />}
    </div>
  )
}

export function UserAvatar({ user, size = 32, className }: UserAvatarProps) {
  const initials = ((user.firstName[0] ?? '') + (user.lastName[0] ?? '')).toUpperCase()

  if (user.avatarUrl) {
    return (
      <img
        src={proxyImg(user.avatarUrl)}
        alt={initials}
        className={cn('rounded-full object-cover shrink-0', className)}
        style={!className?.includes('h-') ? { width: size, height: size } : undefined}
      />
    )
  }

  if (user.dicebearStyle && user.dicebearSeed) {
    return <DicebearSnapshot user={user} size={size} className={cn('rounded-full', className)} />
  }

  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br font-semibold text-white',
        gradientFor(user.id),
        className,
      )}
      style={!className?.includes('h-') ? { width: size, height: size, fontSize: size * 0.35 } : undefined}
    >
      {initials}
    </div>
  )
}
