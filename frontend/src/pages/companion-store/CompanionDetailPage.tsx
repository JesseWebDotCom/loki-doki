import { type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ChevronRight, Lock, ShieldAlert } from 'lucide-react'
import { CharacterAvatar } from '@/components/companion/CharacterAvatar'
import { useCompanionStore, isLocked } from '@/lib/companions/useCompanionStore'
import { getCompanionCategory } from '@/lib/companions/companionCategories'
import { voiceMeta } from '@/lib/companions/voiceCatalog'
import { SelectButton, FavoriteButton, PreviewButton, lockReason } from '@/components/companions/store/CompanionActions'

const DIAL_LABEL: Record<string, string> = { profanity: 'Profanity', sexual: 'Sexual', violence: 'Violence', substances: 'Substances' }
const DIAL_KEYS = ['profanity', 'sexual', 'violence', 'substances'] as const

function StatCol({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0 px-4 text-center">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">{label}</p>
      <p className="mt-1 truncate text-base font-bold leading-tight">{value}</p>
      {sub != null && <p className="truncate text-[11px] text-muted-foreground/70">{sub}</p>}
    </div>
  )
}

export function CompanionDetailPage() {
  const { id = '' } = useParams()
  const { getCompanion, isLoading } = useCompanionStore()
  const c = getCompanion(id)

  if (isLoading && !c) return <div className="px-5 py-20 text-center text-sm text-muted-foreground">Loading…</div>
  if (!c) {
    return (
      <div className="px-5 py-20 text-center text-sm text-muted-foreground">
        Companion not found. <Link to="/companions/browse" className="text-brand hover:underline">Browse all</Link>
      </div>
    )
  }

  const category = getCompanionCategory(c.category)
  const locked = isLocked(c)
  const gradient = category?.gradient ?? 'linear-gradient(135deg,#1a0533,#7c3aed)'
  const voice = voiceMeta(c.ttsVoice)
  const rate = c.speechRate ? `${c.speechRate.toFixed(2)}×` : 'Normal'
  const dials = c.content ? DIAL_KEYS.filter((k) => c.content && c.content[k] && c.content[k] !== 'off') : []
  const rating = category?.mature ? '18+' : dials.length ? 'Mature' : 'All ages'

  return (
    <div className="mx-auto max-w-6xl px-5 py-6 pb-20">
      {/* Breadcrumb — matches the category page nav */}
      <nav className="mb-4 flex items-center gap-1.5 text-sm">
        <Link to="/companions/categories" className="text-muted-foreground hover:text-foreground">Categories</Link>
        {category && (
          <>
            <ChevronRight className="size-3.5 text-muted-foreground/50" />
            <Link to={`/companions/category/${category.key}`} className="text-muted-foreground hover:text-foreground">{category.name}</Link>
          </>
        )}
        <ChevronRight className="size-3.5 text-muted-foreground/50" />
        <span className="font-medium text-foreground">{c.name}</span>
      </nav>

      {/* Colored hero banner */}
      <div className="relative overflow-hidden rounded-3xl p-6 text-white shadow-lg sm:p-8" style={{ backgroundImage: gradient }}>
        <div className="absolute inset-0 bg-gradient-to-r from-black/40 via-black/15 to-transparent" />
        <div className="relative flex flex-col items-center gap-5 sm:flex-row sm:items-center">
          <div className="size-28 shrink-0 overflow-hidden rounded-3xl bg-white/10 ring-2 ring-white/25 backdrop-blur sm:size-32">
            <CharacterAvatar character={c} size={128} viewPreset="head" pokeable={!locked} />
          </div>
          <div className="min-w-0 flex-1 text-center sm:text-left">
            {category && <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-white/75">{category.name}</p>}
            <h1 className="mt-1 text-3xl font-black tracking-tight drop-shadow sm:text-4xl">{c.name}</h1>
            {c.backstory && <p className="mt-1.5 max-w-lg text-sm text-white/85">{c.backstory}</p>}
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5 sm:justify-start">
              {locked ? (
                <span className="inline-flex items-center gap-2 rounded-full bg-black/25 px-4 py-2 text-sm font-medium text-white backdrop-blur">
                  <Lock className="size-4" /> Locked — requires {lockReason(c)}
                </span>
              ) : (
                <SelectButton c={c} size="md" />
              )}
              <PreviewButton c={c} variant="pill" className="!bg-white/15 !text-white hover:!bg-white/25" />
              <FavoriteButton c={c} className="size-10 !border-white/30 !bg-white/15 hover:!bg-white/25" />
            </div>
          </div>
        </div>
      </div>

      {/* Stat columns (App Store-style) */}
      <div className="mt-6 grid grid-cols-3 divide-x divide-border/40 rounded-2xl border border-border/40 bg-card/40 py-4 sm:grid-cols-5">
        <StatCol label="Voice" value={voice?.name ?? '—'} sub={voice ? `${voice.flag} ${voice.country}` : 'App default'} />
        <StatCol label="Gender" value={voice?.gender ?? '—'} sub="Voice" />
        <StatCol label="Style" value={<span className="capitalize">{c.replyStyle}</span>} sub="Replies" />
        <StatCol label="Pace" value={rate} sub="Speech" />
        <StatCol label="Rating" value={rating} sub={category?.name ?? 'Companion'} />
      </div>

      {locked && (
        <p className="mt-3 text-sm text-muted-foreground">
          This companion's content exceeds your current settings. Raise your content ceiling in{' '}
          <Link to="/settings" className="text-brand hover:underline">Settings</Link> to unlock it.
        </p>
      )}

      {/* Mature content badges */}
      {dials.length > 0 && (
        <div className="mt-6 flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="flex flex-wrap gap-2">
            {dials.map((k) => (
              <span key={k} className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-400">
                {DIAL_LABEL[k]}: {c.content?.[k]}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* About — full text */}
      <div className="mt-7">
        <h2 className="mb-2 text-lg font-bold tracking-tight">About {c.name}</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">{c.personalityPrompt}</p>
      </div>
    </div>
  )
}
