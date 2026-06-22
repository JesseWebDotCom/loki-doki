import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/cn'
import { CharacterAvatar } from '@/components/companion/CharacterAvatar'
import { type CompanionRecord } from '@/hooks/useActiveCompanion'
import { isLocked } from '@/lib/companions/useCompanionStore'
import { getCompanionCategory } from '@/lib/companions/companionCategories'
import { SelectButton } from '@/components/companions/store/CompanionActions'

/** Spotlight banner that rotates through a few unlocked companions. */
export function CompanionFeaturedHero({ companions }: { companions: CompanionRecord[] }) {
  const navigate = useNavigate()
  const featured = companions.filter((c) => !isLocked(c)).slice(0, 5)
  const [index, setIndex] = useState(0)

  useEffect(() => {
    if (featured.length <= 1) return
    const t = setInterval(() => setIndex((i) => (i + 1) % featured.length), 6000)
    return () => clearInterval(t)
  }, [featured.length])

  if (featured.length === 0) return null
  const c = featured[Math.min(index, featured.length - 1)]
  const cat = getCompanionCategory(c.category)
  const gradient = cat?.gradient ?? 'linear-gradient(135deg,#1a0533,#7c3aed)'

  return (
    <div className="relative overflow-hidden rounded-3xl p-8 text-white shadow-lg sm:p-10" style={{ backgroundImage: gradient }}>
      <div className="absolute inset-0 bg-gradient-to-r from-black/55 via-black/25 to-transparent" />

      {/* Oversized avatar watermark */}
      <div className="pointer-events-none absolute -right-2 top-1/2 size-56 -translate-y-1/2 opacity-90 sm:right-6">
        <CharacterAvatar character={c} size={224} viewPreset="head" pokeable={false} suppressOverlays ambient />
      </div>

      <div className="relative max-w-lg">
        <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/80">Featured Companion</p>
        <h2 className="mt-2 text-3xl font-black leading-tight drop-shadow sm:text-4xl">{c.name}</h2>
        <p className="mt-3 text-sm text-white/85 sm:text-base">{c.backstory}</p>

        <div className="mt-6 flex items-center gap-3">
          <SelectButton c={c} size="md" />
          <button
            onClick={() => navigate(`/companions/c/${c.id}`)}
            className="inline-flex items-center justify-center rounded-full bg-white/15 px-5 py-2 text-sm font-semibold text-white backdrop-blur transition-colors hover:bg-white/25"
          >
            View Details
          </button>
        </div>
      </div>

      {featured.length > 1 && (
        <div className="absolute bottom-6 right-8 flex gap-1.5">
          {featured.map((f, i) => (
            <button
              key={f.id}
              onClick={() => setIndex(i)}
              aria-label={`Show ${f.name}`}
              className={cn('h-1.5 rounded-full transition-all', i === index ? 'w-6 bg-white' : 'w-1.5 bg-white/40 hover:bg-white/60')}
            />
          ))}
        </div>
      )}
    </div>
  )
}
