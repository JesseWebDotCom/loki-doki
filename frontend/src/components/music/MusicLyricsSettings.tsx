// Music → Lyrics settings: the read-ahead (how early a lyric line highlights before it's sung).
// Personal, per-device preference (localStorage via RadioContext). Applies live to every lyric
// surface — Music Studio, Karaoke, and the Now Playing player.
import { useRadio } from '@/context/RadioContext'
import { cn } from '@/lib/cn'

const PRESETS: { label: string; v: number }[] = [
  { label: 'On the word', v: 0 },
  { label: 'A little early', v: 0.5 },
  { label: 'Early', v: 1.0 },
  { label: 'Way ahead', v: 1.5 },
]

export function MusicLyricsSettings() {
  const { lyricLeadSec, setLyricLeadSec } = useRadio()

  return (
    <section className="max-w-xl space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Lyric timing</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          How far ahead a line lights up before it's sung. A little lead makes the words easier to
          follow and sing along to; set it to zero to highlight exactly on the beat.
        </p>
      </div>

      <div className="rounded-card border border-border/60 bg-card/50 p-4">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">Read-ahead</span>
          <span className="tabular-nums text-muted-foreground">
            {lyricLeadSec <= 0 ? 'On the word' : `${lyricLeadSec.toFixed(1)}s early`}
          </span>
        </div>
        <input
          type="range" min={0} max={3} step={0.1} value={lyricLeadSec}
          onChange={(e) => setLyricLeadSec(Number(e.target.value))}
          aria-label="Lyric read-ahead (seconds)"
          className="mt-2 w-full accent-brand"
        />
        <div className="mt-3 flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.label} type="button" onClick={() => setLyricLeadSec(p.v)}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-medium transition',
                Math.abs(lyricLeadSec - p.v) < 0.05
                  ? 'bg-brand text-brand-foreground'
                  : 'bg-foreground/8 text-muted-foreground hover:bg-foreground/15',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Applies everywhere lyrics scroll — Music Studio, Karaoke, and the Now Playing player.
      </p>
    </section>
  )
}
