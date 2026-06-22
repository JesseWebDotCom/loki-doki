import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/cn'
import { PrimaryAction } from '@/components/store/StoreActions'
import type { StoreApp } from '@/lib/store/useStoreApps'

/** Preferred apps to spotlight, in order. Missing ones are skipped. */
const FEATURED_IDS = ['chat', 'image_gen', 'maps', 'weather', 'youtube', 'news']

function pickFeatured(apps: StoreApp[]): StoreApp[] {
  const byId = new Map(apps.map(a => [a.id, a]))
  const picked = FEATURED_IDS.map(id => byId.get(id)).filter(Boolean) as StoreApp[]
  if (picked.length >= 3) return picked.slice(0, 5)
  // Fall back to filling from whatever exists.
  const extra = apps.filter(a => !picked.includes(a))
  return [...picked, ...extra].slice(0, 5)
}

/** Auto-rotating front-page hero banner. */
export function FeaturedHero({ apps }: { apps: StoreApp[] }) {
  const navigate = useNavigate()
  const featured = pickFeatured(apps)
  const [index, setIndex] = useState(0)

  useEffect(() => {
    if (featured.length <= 1) return
    const t = setInterval(() => setIndex(i => (i + 1) % featured.length), 6000)
    return () => clearInterval(t)
  }, [featured.length])

  if (featured.length === 0) return null
  const app = featured[Math.min(index, featured.length - 1)]
  const Icon = app.icon

  return (
    <div
      className="relative overflow-hidden rounded-3xl p-8 text-white shadow-lg sm:p-10"
      style={app.gradient ? { backgroundImage: app.gradient } : undefined}
    >
      <div className="absolute inset-0 bg-gradient-to-r from-black/55 via-black/25 to-transparent" />

      {/* Oversized watermark icon */}
      <Icon className="pointer-events-none absolute -right-6 top-1/2 size-64 -translate-y-1/2 text-white/10" />

      <div className="relative max-w-lg">
        <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/80">Featured</p>
        <h2 className="mt-2 text-3xl font-black leading-tight drop-shadow sm:text-4xl">{app.name}</h2>
        <p className="mt-3 text-sm text-white/85 sm:text-base">{app.description}</p>

        <div className="mt-6 flex items-center gap-3">
          <PrimaryAction app={app} size="md" />
          <button
            onClick={() => navigate(`/app-store/app/${app.id}`)}
            className="inline-flex items-center justify-center rounded-full bg-white/15 px-5 py-2 text-sm font-semibold text-white backdrop-blur transition-colors hover:bg-white/25"
          >
            View Details
          </button>
        </div>
      </div>

      {/* Carousel dots */}
      {featured.length > 1 && (
        <div className="absolute bottom-6 right-8 flex gap-1.5">
          {featured.map((f, i) => (
            <button
              key={f.id}
              onClick={() => setIndex(i)}
              aria-label={`Show ${f.name}`}
              className={cn(
                'h-1.5 rounded-full transition-all',
                i === index ? 'w-6 bg-white' : 'w-1.5 bg-white/40 hover:bg-white/60',
              )}
            />
          ))}
        </div>
      )}
    </div>
  )
}
