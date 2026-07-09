// Cross-app "send to karaoke" channel. Any surface (the mini player, Now Playing, a song row)
// can drop a song here and navigate to /music/karaoke; the karaoke page drains pending seeds
// on mount and while open. A tiny module store so it works without threading a provider through
// the whole app.

export interface KaraokeSeed {
  videoId: string
  title: string
  artist: string
  durationSec: number | null
}

const pending: KaraokeSeed[] = []
const subs = new Set<() => void>()

/** Queue a song for karaoke. Call `navigate('/music/karaoke')` right after. */
export function queueForKaraoke(seed: KaraokeSeed): void {
  pending.push(seed)
  subs.forEach((fn) => fn())
}

/** Take (and clear) everything queued so far. Called by the karaoke page. */
export function drainKaraokeSeeds(): KaraokeSeed[] {
  return pending.splice(0, pending.length)
}

export function subscribeKaraoke(fn: () => void): () => void {
  subs.add(fn)
  return () => { subs.delete(fn) }
}
