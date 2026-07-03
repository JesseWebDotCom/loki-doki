import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { CharacterAvatar } from '@/components/companion/CharacterAvatar'
import { type CompanionRecord } from '@/hooks/useActiveCompanion'
import { isLocked } from '@/lib/companions/useCompanionStore'
import { getCompanionCategory } from '@/lib/companions/companionCategories'
import { SelectButton } from '@/components/companions/store/CompanionActions'

/** Fallback identity gradient for companions without a category (matches "everyday").
 *  design-ok(hex-in-tsx): identity gradient data for uncategorized companions */
export const COMPANION_FALLBACK_GRADIENT = 'linear-gradient(135deg,#1a0533,#7c3aed)'

/** Spotlight banner that rotates through a few unlocked companions. Category-gradient
 *  fill is a sanctioned identity moment (store cards); text over artwork keeps white-alpha. */
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
  const gradient = cat?.gradient ?? COMPANION_FALLBACK_GRADIENT

  return (
    <div className="relative overflow-hidden rounded-sheet p-8 text-white shadow-lg sm:p-10" style={{ backgroundImage: gradient }}>
      <div className="absolute inset-0 bg-gradient-to-r from-black/55 via-black/25 to-transparent" />

      {/* Oversized avatar watermark */}
      <div className="pointer-events-none absolute -right-2 top-1/2 size-56 -translate-y-1/2 opacity-90 sm:right-6">
        <CharacterAvatar character={c} size={224} viewPreset="head" pokeable={false} suppressOverlays ambient />
      </div>

      <div className="relative max-w-lg">
        <p className="text-overline text-white/80">Featured Companion</p>
        <h2 className="mt-2 text-display text-white drop-shadow sm:text-display-lg">{c.name}</h2>
        <p className="mt-3 text-sm text-white/85 sm:text-base">{c.backstory}</p>

        <div className="mt-6 flex items-center gap-3">
          <SelectButton c={c} size="md" />
          <Button
            onClick={() => navigate(`/companions/c/${c.id}`)}
            className="bg-white/15 text-white hover:bg-white/25"
          >
            View Details
          </Button>
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
