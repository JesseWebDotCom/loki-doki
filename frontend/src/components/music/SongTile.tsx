// A song tile the way modern players draw them: square album art with the title overlaid
// on a bottom gradient, no card chrome, gentle hover lift. Shared by the Listen/Library
// shelves and Browse.

import { SongArt } from '@/components/music/SongArt'

export function SongTile({ trackRef, title, artist, onClick, size = 'w-44' }: {
  trackRef: string
  title: string
  artist: string | null
  onClick: () => void
  size?: string
}) {
  return (
    <button onClick={onClick} className={`group ${size} shrink-0 text-left`}>
      <div className="relative overflow-hidden rounded-card shadow-md transition duration-200 group-hover:scale-[1.03] group-hover:shadow-xl">
        <SongArt trackRef={trackRef} title={title} artist={artist} className="aspect-square w-full" rounded="rounded-card" />
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/85 via-black/35 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 p-2.5">
          <p className="truncate text-[13px] font-semibold text-white">{title}</p>
          {artist && <p className="truncate text-[11px] text-white/60">{artist}</p>}
        </div>
      </div>
    </button>
  )
}
