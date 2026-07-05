// Plex NFO XML builders — the Local Media Assets / NFO agent convention (deliberately not
// a custom Plex Agent/Scanner, see project plan). Pure string building, no IO.

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

export function buildTvShowNfo(opts: { title: string; plot: string }): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<tvshow>
  <title>${esc(opts.title)}</title>
  <plot>${esc(opts.plot)}</plot>
</tvshow>
`
}

/** `aired` must be YYYY-MM-DD (Plex/Kodi NFO convention) or omitted. */
export function buildEpisodeNfo(opts: { title: string; plot: string; aired: string | null; season: number; episode: number }): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<episodedetails>
  <title>${esc(opts.title)}</title>
  <plot>${esc(opts.plot)}</plot>
  ${opts.aired ? `<aired>${esc(opts.aired)}</aired>` : ''}
  <season>${opts.season}</season>
  <episode>${opts.episode}</episode>
</episodedetails>
`
}

/** A hash of whatever fields determine "does tvshow.nfo need to be rewritten" — cheap
 *  string concat, not cryptographic; collisions here only cost a redundant rewrite. */
export function showNfoHash(opts: { title: string; description: string | null; avatarUrl: string | null; bannerUrl: string | null }): string {
  return [opts.title, opts.description ?? '', opts.avatarUrl ?? '', opts.bannerUrl ?? ''].join('')
}
