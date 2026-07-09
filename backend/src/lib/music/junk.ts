// Junk filter for station/radio tracklists. YouTube (and, less often, community playlists) are full
// of uploads that are not the studio SONG a music station wants: sound-effect libraries, "type beat"
// instrumentals, karaoke/tribute re-records, hour-long compilations, "Top 100 Best Selling Chart
// Hits Vol. 8" dumps, and generic compilation "artists" whose name is just a vibe ("Lofi Hip-Hop
// Beats", "Chill Out", "Today's Hits"). These slip past a title cleaner because the words are real;
// the tell is the phrasing and the artist identity. Drop them outright.
//
// Tuned conservatively against real harness output so it removes the obvious garbage without
// nuking legitimate songs — when unsure, keep the track (the YouTube resolver's confidence floor
// is the second line of defense).

// Unambiguous non-song phrasing, checked against "title + artist".
const JUNK_PHRASE =
  /\b(type ?beat|sound ?effects?|sound ?fx|sfx|foley|backing track|jam track|practice track|play[- ]?along|drumless|guitar backing|karaoke|made famous by|in the style of|originally performed|as made popular by|as made famous|tribute to|greatest hits band|theme players|theme song library|song library|music band|cover band|lullaby (?:version|renditions?)|rockabye|white noise|brown noise|pink noise|nature sounds?|rain sounds?|ocean sounds?|forest sounds?|sleep sounds?|asmr|full album|mega ?mix|continuous mix|non[- ]?stop mix|dj mix|mixtape mix|chart hits|best selling|top \d{2,}|\d+\s*hours?\b|\d+\s*min(?:ute)?s? (?:mix|of)|ringtone|no copyright|copyright[- ]free|royalty[- ]free|\bncs\b|\bbgm\b|\bplaylist\b)\b/i

// Stock jam/backing uploads name the musical key instead of a song ("Blues Rock Classic Jam
// track in A", "Slow Groove Jam in E minor"). Only fires when a stock-tell word precedes the
// "in <key>" tail, so real titles that merely contain "in a" ("Lost in a Dream") and classical
// pieces ("Toccata and Fugue in D minor") survive.
const JUNK_KEY_SUFFIX =
  /\b(?:jam|groove|backing|practice|shuffle)\b.*\bin [a-g](?: ?(?:#|b|sharp|flat))? ?(?:minor|major|min|maj|m)?\s*$/i

// Words that, on their own, describe a vibe/genre rather than name an artist. When EVERY token of
// the artist name is one of these (and there are at least two), the "artist" is a compilation/lofi
// channel, not a band — e.g. "Lofi Hip-Hop Beats", "Chill Out", "Soft Jazz Mood", "Hits Of The 80's".
const GENERIC_TOKENS = new Set(
  ('lofi lo fi beats beat chill chillhop chillout hits hit jazz jazzy music musica sounds sound ' +
    'playlist mix mixes study studying relax relaxing relaxation vibes vibe hop hiphop instrumental ' +
    'instrumentals bgm lounge ambient cafe coffee radio top best classic classics smooth deep focus ' +
    'sleep sleepy piano soft nation world party chillhop downtempo meditation meditative yoga calm ' +
    'calming peaceful zen muzak elevator background nightcore mood moods bossa nova soul funk groove ' +
    'grooves today todays sad the of and to for a an your my collection essentials anthems life live').split(' '),
)

// A name/title is a "vibe label" (not a real artist or song) when every token is a generic
// descriptor and there are at least two of them — "Lofi Hip-Hop Beats", "Chill Out", "Party Hits".
function isGenericName(s: string): boolean {
  const toks = (s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  if (toks.length < 2) return false
  // numeric-only tokens (e.g. "80", "2023") count as generic in a vibe name like "Hits Of The 80's"
  return toks.every((t) => GENERIC_TOKENS.has(t) || /^\d+$/.test(t) || t.length === 1)
}

/** True when a candidate is clearly NOT a real studio song the station should play. */
export function isJunkTrack(title: string, artist: string): boolean {
  const t = title ?? ''
  const a = artist ?? ''
  if (!t.trim()) return true
  if (JUNK_PHRASE.test(`${t} ${a}`)) return true
  if (JUNK_KEY_SUFFIX.test(t)) return true
  if (isGenericName(a)) return true   // compilation/lofi "artist"
  if (isGenericName(t)) return true   // vibe-label "song" (e.g. "Lofi & Chill", "Party Hits")
  return false
}

/** Filter a list of {title, artist}-bearing tracks, dropping junk. Generic over the item shape. */
export function dropJunk<T extends { title: string; artist?: string | null }>(tracks: T[]): T[] {
  return tracks.filter((x) => !isJunkTrack(x.title, x.artist ?? ''))
}

// Non-music YOUTUBE VIDEO tells — trailers, reviews, tech setups, gameplay, etc. Distinct from the
// music-junk filter above (which targets fake "songs" like type-beats and karaoke). These leak into
// listening history when a companion "play music" request is mis-parsed into a station whose free-text
// seed resolves to an ordinary YouTube video (e.g. a movie trailer) that then plays as audio. High-
// precision terms only — words that essentially never appear in a real song title.
const VIDEO_PHRASE =
  /\b(official trailer|teaser trailer|trailer|teaser|unboxing|reaction video|reacts to|first look|hands[- ]?on|room tour|house tour|studio tour|apartment tour|\bsetup\b|\bvlog\b|gameplay|walkthrough|playthrough|let'?s play|tutorial|documentary|full episode|full movie|caught on camera|dash ?cam|body ?cam)\b/i

/**
 * True when a history entry is clearly an ordinary (non-music) YouTube video rather than a song —
 * used to keep trailers/reviews/setup videos out of the music "Continue listening" list. A real
 * artist name is never a sentence, so a '?' or an implausibly long artist is a strong tell too.
 */
export function looksLikeVideo(title: string, artist: string): boolean {
  const t = title ?? ''
  const a = artist ?? ''
  if (VIDEO_PHRASE.test(`${t} ${a}`)) return true
  if (a.includes('?')) return true                                   // "Have you seen new Spiderman movie?"
  if (a.trim().split(/\s+/).filter(Boolean).length >= 8) return true // a sentence, not an artist
  return false
}
