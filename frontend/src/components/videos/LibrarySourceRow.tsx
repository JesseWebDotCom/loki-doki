import { ChipRow, Chip } from '@/components/shared/ChipRow'
import { SourceChip } from '@/components/videos/SourceChip'
import type { VideoSource } from '@/lib/videos/api'

export type LibrarySourceFilter = 'all' | VideoSource

/** The Library pages' shared source filter row (All + one pill per source with content). */
export function LibrarySourceRow({ available, active, onChange, className }: {
  available: VideoSource[]
  active: LibrarySourceFilter
  onChange: (f: LibrarySourceFilter) => void
  className?: string
}) {
  return (
    <ChipRow className={className ?? 'mb-6'}>
      <Chip label="All" active={active === 'all'} onClick={() => onChange('all')} />
      {available.map((s) => (
        <SourceChip key={s} source={s} active={active === s} onClick={() => onChange(active === s ? 'all' : s)} />
      ))}
    </ChipRow>
  )
}
