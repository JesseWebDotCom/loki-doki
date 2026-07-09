// Icon-only discography filter, shared by the artist page and Browse search results.
// MusicBrainz catalogs every club bootleg and demo tape; the toggle set decides which
// release kinds show. Live/demos/mixtapes/remixes are hidden by DEFAULT; studio albums
// always show; compilations and soundtracks show unless switched off.

import { ListFilter } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuCheckboxItem, DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'
import type { CatalogAlbum } from '@/lib/music/catalogApi'

export interface AlbumFilterCat {
  key: string
  label: string
  match: string[]        // MB secondary types (lowercased) this category covers
  defaultOn: boolean
}

export const ALBUM_FILTER_CATS: AlbumFilterCat[] = [
  { key: 'live', label: 'Live recordings', match: ['live'], defaultOn: false },
  { key: 'demo', label: 'Demos', match: ['demo'], defaultOn: false },
  { key: 'compilation', label: 'Compilations', match: ['compilation'], defaultOn: true },
  { key: 'soundtrack', label: 'Soundtracks', match: ['soundtrack'], defaultOn: true },
  { key: 'remix', label: 'Remixes & DJ mixes', match: ['remix', 'dj-mix'], defaultOn: false },
  { key: 'mixtape', label: 'Mixtapes & field recordings', match: ['mixtape/street', 'field recording'], defaultOn: false },
]

export type AlbumFilters = Record<string, boolean>

export const defaultAlbumFilters = (): AlbumFilters =>
  Object.fromEntries(ALBUM_FILTER_CATS.map(c => [c.key, c.defaultOn]))

/** An album passes when every category it belongs to is switched on (studio = no
 *  categories = always passes). */
export function albumPassesFilters(a: Pick<CatalogAlbum, 'secondaryTypes'>, filters: AlbumFilters): boolean {
  const types = (a.secondaryTypes ?? []).map(t => t.toLowerCase())
  if (!types.length) return true
  for (const cat of ALBUM_FILTER_CATS) {
    if (types.some(t => cat.match.includes(t)) && !filters[cat.key]) return false
  }
  return true
}

export function AlbumFilterButton({ albums, filters, onChange }: {
  albums: Array<Pick<CatalogAlbum, 'secondaryTypes'>>
  filters: AlbumFilters
  onChange: (next: AlbumFilters) => void
}) {
  // Only offer categories that exist in this list, with counts.
  const cats = ALBUM_FILTER_CATS
    .map(cat => ({
      ...cat,
      count: albums.filter(a => (a.secondaryTypes ?? []).some(t => cat.match.includes(t.toLowerCase()))).length,
    }))
    .filter(c => c.count > 0)
  if (!cats.length) return null
  const hidingSome = cats.some(c => !filters[c.key])

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="icon-sm" aria-label="Filter releases" title="Filter releases" className="relative">
          <ListFilter className="size-4" />
          {hidingSome && <span aria-hidden className="absolute right-1 top-1 size-1.5 rounded-full bg-brand" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>Show release types</DropdownMenuLabel>
        {cats.map(cat => (
          <DropdownMenuCheckboxItem key={cat.key} checked={!!filters[cat.key]}
            onCheckedChange={v => onChange({ ...filters, [cat.key]: v === true })}
            onSelect={e => e.preventDefault()}>
            <span className="flex-1">{cat.label}</span>
            <span className="text-caption tabular-nums text-muted-foreground">{cat.count}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
