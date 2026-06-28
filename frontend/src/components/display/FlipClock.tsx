import { useEffect, useState } from 'react'

// Split-flap "flip clock" — the old airport/train-board cards that fold each
// digit over as it changes. Pure CSS (no images): each digit is two stacked
// half-cards; on a value change an old-top leaf folds down while a new-bottom
// leaf unfolds up. Sizing is driven entirely by the inherited font-size, so the
// same component scales from a full-screen display to a tiny admin preview.

function FlipDigit({ value }: { value: string }) {
  const [d, setD] = useState({ cur: value, prev: value })
  useEffect(() => {
    setD((s) => (s.cur === value ? s : { cur: value, prev: s.cur }))
  }, [value])
  const flipping = d.cur !== d.prev

  return (
    <div className="flip-digit">
      {/* Static faces: new top is revealed immediately; old bottom lingers until the unfold completes. */}
      <div className="flip-half flip-top"><span>{d.cur}</span></div>
      <div className="flip-half flip-bottom"><span>{flipping ? d.prev : d.cur}</span></div>
      {flipping && (
        <div className="flip-anim">
          <div className="flip-half flip-top flip-fold-top"><span>{d.prev}</span></div>
          <div
            className="flip-half flip-bottom flip-fold-bottom"
            onAnimationEnd={() => setD((s) => ({ cur: s.cur, prev: s.cur }))}
          >
            <span>{d.cur}</span>
          </div>
        </div>
      )}
    </div>
  )
}

export interface FlipClockProps {
  hh: string
  mm: string
  ss?: string
  ampm?: string
  className?: string
  style?: React.CSSProperties
}

export function FlipClock({ hh, mm, ss, ampm, className, style }: FlipClockProps) {
  return (
    <div className={`flip-clock${className ? ` ${className}` : ''}`} style={style}>
      <FlipDigit value={hh[0]!} />
      <FlipDigit value={hh[1]!} />
      <span className="flip-colon">:</span>
      <FlipDigit value={mm[0]!} />
      <FlipDigit value={mm[1]!} />
      {ss !== undefined && (
        <>
          <span className="flip-colon">:</span>
          <FlipDigit value={ss[0]!} />
          <FlipDigit value={ss[1]!} />
        </>
      )}
      {ampm ? <span className="flip-ampm">{ampm}</span> : null}
    </div>
  )
}
