import { useNavigate } from 'react-router-dom'
import { PrimaryAction } from '@/components/store/StoreActions'
import type { StoreApp } from '@/lib/store/useStoreApps'

/** Large tinted 3-up card for a category's Featured strip. */
export function FeaturedCard({ app }: { app: StoreApp }) {
  const navigate = useNavigate()
  const Icon = app.icon
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => navigate(`/app-store/app/${app.id}`)}
      onKeyDown={e => { if (e.key === 'Enter') navigate(`/app-store/app/${app.id}`) }}
      className="group relative flex cursor-pointer flex-col gap-4 overflow-hidden rounded-2xl border border-border/40 p-5"
      style={app.gradient ? { backgroundImage: app.gradient } : undefined}
    >
      {/* Darkening scrim so text stays legible over the gradient */}
      <div className="absolute inset-0 bg-black/35 transition-colors group-hover:bg-black/25" />

      <div className="relative flex items-center gap-3">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-white/15 backdrop-blur">
          <Icon className="size-6 text-white drop-shadow" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-base font-bold text-white drop-shadow">{app.name}</p>
          <p className="truncate text-xs text-white/80">{app.category}</p>
        </div>
      </div>

      <p className="relative line-clamp-2 text-sm text-white/90">{app.description}</p>

      <div className="relative mt-auto flex items-center justify-between">
        <span className="text-xs font-medium text-white/70">{app.offline ? 'Extension' : 'App'}</span>
        <PrimaryAction app={app} />
      </div>
    </div>
  )
}
