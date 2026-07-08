import { ChipRow, Chip } from '@/components/shared/ChipRow'
import { SourceChip, MineChip } from '@/components/videos/SourceChip'
import type { VideoSource } from '@/lib/videos/api'

export type LibrarySourceFilter = 'all' | 'mine' | VideoSource

/** The Library pages' shared source filter row: Mine (your own Studio content) leads every
 *  row, then All + one pill per source with content. */
export function LibrarySourceRow({ available, active, onChange, className }: {
  available: VideoSource[]
  active: LibrarySourceFilter
  onChange: (f: LibrarySourceFilter) => void
  className?: string
}) {
  return (
    <ChipRow className={className ?? 'mb-6'}>
      <MineChip active={active === 'mine'} onClick={() => onChange(active === 'mine' ? 'all' : 'mine')} />
      <Chip label="All" active={active === 'all'} onClick={() => onChange('all')} />
      {available.map((s) => (
        <SourceChip key={s} source={s} active={active === s} onClick={() => onChange(active === s ? 'all' : s)} />
      ))}
    </ChipRow>
  )
}
