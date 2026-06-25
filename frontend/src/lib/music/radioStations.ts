// AI Radio station presets. Each station drives two kinds of search:
//  - ytQueries: a POOL of song-queue searches (full music videos, played as audio-only).
//               One is picked at random per tune-in and its results are shuffled, so the
//               same station doesn't replay the same fixed top-12 every time.
//  - bedQuery:  a single genre-matched INSTRUMENTAL (no vocals) looped low under the DJ
//               between tracks, so there's never dead air while the host talks.

export interface DjStation {
  id: string
  label: string
  emoji: string
  color: string
  colorDark: string
  // Legacy preset stations drive the queue from these YouTube searches.
  genre?: string
  ytQueries?: string[]
  bedQuery?: string
  // AI stations (saved in music_stations) drive the queue from the station engine instead:
  // either a saved station id, or an inline prompt / artist-song seed. djMode controls the DJ.
  stationId?: string
  aiPrompt?: string
  seedType?: 'prompt' | 'genre' | 'artist' | 'song'
  seedValue?: string
  djMode?: 'full' | 'minimal' | 'silent'
}

export const DJ_STATIONS: DjStation[] = [
  { id: 'pop', label: 'Pop Hits', genre: 'pop', emoji: '🎤', color: '#ec4899', colorDark: '#db2777',
    bedQuery: 'pop backing track instrumental',
    ytQueries: ['pop hits official music video', 'top pop songs official video', '2010s pop hits official music video', 'pop anthems official music video'] },
  { id: 'rock', label: 'Rock Classics', genre: 'rock', emoji: '🎸', color: '#f97316', colorDark: '#dc2626',
    bedQuery: 'rock backing track instrumental',
    ytQueries: ['classic rock hits official music video', 'alternative rock official music video', '90s rock hits official video', 'best rock songs official music video'] },
  { id: 'hiphop', label: 'Hip-Hop', genre: 'hip-hop', emoji: '🎧', color: '#a855f7', colorDark: '#7c3aed',
    bedQuery: 'hip hop instrumental beat',
    ytQueries: ['hip hop hits official video', 'rap official music video', '2010s hip hop official video', 'best rap songs official music video'] },
  { id: 'jazz', label: 'Jazz Café', genre: 'jazz', emoji: '🎷', color: '#3b82f6', colorDark: '#1d4ed8',
    bedQuery: 'jazz backing track instrumental',
    ytQueries: ['jazz classics live performance', 'smooth jazz performance', 'jazz standards live', 'modern jazz live performance'] },
  { id: 'electronic', label: 'Electronic', genre: 'electronic', emoji: '🎛️', color: '#06b6d4', colorDark: '#0284c7',
    bedQuery: 'electronic instrumental beat',
    ytQueries: ['electronic dance music official video', 'EDM hits official video', 'house music official video', 'best electronic songs official video'] },
  { id: 'country', label: 'Country', genre: 'country', emoji: '🤠', color: '#84cc16', colorDark: '#16a34a',
    bedQuery: 'country backing track instrumental',
    ytQueries: ['country hits official music video', 'modern country official video', 'classic country official video', 'best country songs official music video'] },
  { id: 'rnb', label: 'R&B Soul', genre: 'r&b', emoji: '🎵', color: '#f43f5e', colorDark: '#be123c',
    bedQuery: 'r&b instrumental beat',
    ytQueries: ['r&b hits official video', 'soul music official video', '2010s r&b official video', 'best r&b songs official music video'] },
  { id: 'metal', label: 'Heavy Metal', genre: 'metal', emoji: '⚡', color: '#6b7280', colorDark: '#374151',
    bedQuery: 'heavy metal backing track instrumental',
    ytQueries: ['heavy metal hits official music video', 'best metal songs official video', 'thrash metal classics official video', 'metalcore official music video'] },
]
