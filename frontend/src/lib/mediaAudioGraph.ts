// One shared Web-Audio graph per media element: source → gain → destination, with an
// analyser tapped off the (post-gain) signal. Both consumers go through here so they can't
// fight over the element:
//   - useAudioBoost turns the gain knob (volume past 100%)
//   - useMediaAnalyser reads the analyser (EQ visualizer)
// createMediaElementSource can only be called ONCE per media element, ever, across every
// AudioContext - a second call throws - so the graph is built at most once per element
// (WeakMap) and never torn down; the element's GC reclaims it. All graphs share ONE lazy
// AudioContext: browsers cap live contexts (~6), and per-video contexts would exhaust that,
// while sources from many elements coexist fine on a single context. Creation/resume must
// happen inside (or after) a user gesture - callers invoke this from a gesture-adjacent
// moment (a boost interaction, the element's own 'play' event), never on mount.

export interface MediaAudioGraph {
  gain: GainNode
  analyser: AnalyserNode
}

const graphs = new WeakMap<HTMLMediaElement, MediaAudioGraph>()
let sharedCtx: AudioContext | null = null

function ensureContext(): AudioContext | null {
  if (sharedCtx) return sharedCtx
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  try { sharedCtx = new Ctor() } catch { return null }
  return sharedCtx
}

/** Get (or build) the element's audio graph. Returns null when Web Audio is unavailable or
 *  the element was already sourced by something outside this module. Also nudges the shared
 *  context out of 'suspended' - safe to call repeatedly. */
export function ensureMediaGraph(el: HTMLMediaElement): MediaAudioGraph | null {
  const actx = ensureContext()
  if (!actx) return null
  void actx.resume?.()
  const existing = graphs.get(el)
  if (existing) return existing
  try {
    const source = actx.createMediaElementSource(el)
    const gain = actx.createGain()
    const analyser = actx.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.55
    analyser.minDecibels = -85
    analyser.maxDecibels = -12
    source.connect(gain)
    gain.connect(actx.destination)  // keep it audible
    gain.connect(analyser)          // parallel read tap (post-gain, so EQ reflects boost)
    const graph = { gain, analyser }
    graphs.set(el, graph)
    return graph
  } catch {
    // Already sourced elsewhere, or Web Audio unsupported.
    return null
  }
}
