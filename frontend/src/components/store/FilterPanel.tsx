import { Check } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { StoreApp } from '@/lib/store/useStoreApps'

export type SortMode = 'relevance' | 'name' | 'installed'

export interface StoreFilters {
  app: boolean
  extension: boolean
  installed: boolean
  notInstalled: boolean
  online: boolean
  offline: boolean
  sort: SortMode
}

export const DEFAULT_FILTERS: StoreFilters = {
  app: true,
  extension: true,
  installed: true,
  notInstalled: true,
  online: true,
  offline: true,
  sort: 'relevance',
}

/** Apply the active filters + sort to a list of apps. */
export function applyFilters(apps: StoreApp[], f: StoreFilters): StoreApp[] {
  const out = apps.filter(a => {
    if (!f.app && !a.offline) return false
    if (!f.extension && a.offline) return false
    if (!f.installed && a.enabled) return false
    if (!f.notInstalled && !a.enabled) return false
    if (!f.online && a.online) return false
    if (!f.offline && !a.online) return false
    return true
  })
  if (f.sort === 'name') out.sort((a, b) => a.name.localeCompare(b.name))
  else if (f.sort === 'installed') out.sort((a, b) => Number(b.enabled) - Number(a.enabled))
  return out
}

function CheckRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!checked)} className="flex w-full items-center gap-2.5 py-1 text-left">
      <span className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded border transition-colors',
        checked ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-border bg-transparent',
      )}>
        {checked && <Check className="size-3" strokeWidth={3} />}
      </span>
      <span className="text-sm text-muted-foreground">{label}</span>
    </button>
  )
}

function RadioRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return (
    <button onClick={onChange} className="flex w-full items-center gap-2.5 py-1 text-left">
      <span className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors',
        checked ? 'border-emerald-500' : 'border-border',
      )}>
        {checked && <span className="size-2 rounded-full bg-emerald-500" />}
      </span>
      <span className="text-sm text-muted-foreground">{label}</span>
    </button>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-semibold">{title}</p>
      <div>{children}</div>
    </div>
  )
}

export function FilterPanel({ filters, onChange, className }: {
  filters: StoreFilters
  onChange: (f: StoreFilters) => void
  className?: string
}) {
  const set = (patch: Partial<StoreFilters>) => onChange({ ...filters, ...patch })
  return (
    <aside className={cn('w-60 shrink-0 space-y-6 rounded-2xl border border-border/40 bg-card p-5', className)}>
      <div className="flex items-center justify-between">
        <h3 className="text-base font-bold">Filters</h3>
        <button onClick={() => onChange(DEFAULT_FILTERS)} className="text-xs font-medium text-brand hover:underline">
          Clear all
        </button>
      </div>

      <Group title="Type">
        <CheckRow label="Apps" checked={filters.app} onChange={v => set({ app: v })} />
        <CheckRow label="Extensions" checked={filters.extension} onChange={v => set({ extension: v })} />
      </Group>

      <Group title="Status">
        <CheckRow label="Installed" checked={filters.installed} onChange={v => set({ installed: v })} />
        <CheckRow label="Not installed" checked={filters.notInstalled} onChange={v => set({ notInstalled: v })} />
      </Group>

      <Group title="Connectivity">
        <CheckRow label="Connects online" checked={filters.online} onChange={v => set({ online: v })} />
        <CheckRow label="Runs locally" checked={filters.offline} onChange={v => set({ offline: v })} />
      </Group>

      <Group title="Sort by">
        <RadioRow label="Relevance" checked={filters.sort === 'relevance'} onChange={() => set({ sort: 'relevance' })} />
        <RadioRow label="Name (A–Z)" checked={filters.sort === 'name'} onChange={() => set({ sort: 'name' })} />
        <RadioRow label="Installed first" checked={filters.sort === 'installed'} onChange={() => set({ sort: 'installed' })} />
      </Group>
    </aside>
  )
}
