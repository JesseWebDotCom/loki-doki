// Plex NFO XML builders — the Local Media Assets / NFO agent convention (deliberately not
// a custom Plex Agent/Scanner, see project plan). Pure string building, no IO.

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** `namedSeasons` renders as Kodi/Plex's `<namedseason number="N">Title</namedseason>` tags —
 *  season 0 is omitted since Plex already auto-labels it "Specials" without one. Our seasons
 *  are calendar years, so there's no more specific name available than the year itself; this
 *  still satisfies the tag's real purpose (Plex shows this text instead of a bare "Season
 *  2026" heading) rather than being pure redundancy. */
export function buildTvShowNfo(opts: { title: string; plot: string; namedSeasons?: Array<{ number: number; name: string }> }): string {
  const named = (opts.namedSeasons ?? []).filter(s => s.number !== 0)
    .map(s => `  <namedseason number="${s.number}">${esc(s.name)}</namedseason>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<tvshow>
  <title>${esc(opts.title)}</title>
  <plot>${esc(opts.plot)}</plot>
${named ? named + '\n' : ''}</tvshow>
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
 *  string concat, not cryptographic; collisions here only cost a redundant rewrite. Includes
 *  the known season list so a video landing in a season not seen before (a new upload year)
 *  triggers a rewrite that adds its namedseason tag, not just title/art changes. */
export function showNfoHash(opts: { title: string; description: string | null; avatarUrl: string | null; bannerUrl: string | null; seasonYears: number[] }): string {
  return [opts.title, opts.description ?? '', opts.avatarUrl ?? '', opts.bannerUrl ?? '', opts.seasonYears.slice().sort((a, b) => a - b).join(',')].join('|')
}
