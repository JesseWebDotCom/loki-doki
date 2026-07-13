// One shared Web-Audio graph per media element - now a full DSP chain:
//
//   source → preGain (loudness trim) → 10 EQ biquads → crossfeed (bypassable) → gain → destination
//                                                                                 ├→ analyser (per-element)
//                                                                                 └→ shared analyser (mix bus)
//
// All consumers go through here so they can't fight over the element:
//   - useAudioBoost turns the `gain` knob (volume past 100%)
//   - useMediaAnalyser reads the per-element analyser
//   - the radio engine routes its decks here (kind 'music'/'voice') and the EQ
//     visualizer reads the shared analyser (the whole mix, DJ included)
//   - the EQ/loudness/crossfeed settings apply to every live graph at once
//
// createMediaElementSource can only be called ONCE per media element, ever, across every
// AudioContext - a second call throws - so the graph is built at most once per element
// (WeakMap) and never torn down; the element's GC reclaims it. All graphs share ONE lazy
// AudioContext: browsers cap live contexts (~6). Creation/resume must happen inside (or
// after) a user gesture - callers invoke this from a gesture-adjacent moment (a boost
// interaction, the element's own 'play' event, the radio start() click), never on mount.
//
// DSP posture: the chain is ADDITIVE and never load-bearing - mixing stays on el.volume,
// and if the graph fails to attach, playback still works, just un-EQ'd.

export const EQ_BANDS_HZ = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const
export type EqGains = number[]   // dB per band, length 10, ±12

export interface DspSettings {
  eqOn: boolean
  eqGains: EqGains
  crossfeed: boolean
  loudnessOn: boolean
}

export const FLAT_EQ: EqGains = Array(EQ_BANDS_HZ.length).fill(0)
export const DEFAULT_DSP: DspSettings = { eqOn: false, eqGains: [...FLAT_EQ], crossfeed: false, loudnessOn: true }

export interface MediaAudioGraph {
  gain: GainNode
  analyser: AnalyserNode
  /** 'voice' graphs (DJ speech) skip loudness trim - narration is already levelled. */
  kind: 'music' | 'voice'
  preGain: GainNode
  eq: BiquadFilterNode[]
  crossfeedWet: GainNode
  /** The loudness trim this element WOULD apply; gated by settings.loudnessOn. */
  trimDb: number
}

const graphs = new WeakMap<HTMLMediaElement, MediaAudioGraph>()
// Apply-to-all needs an iterable of graphs, but a strong Set would pin every graph (and, through
// its source node, every <video>/<audio> element that ever got one) for the tab's lifetime,
// defeating the WeakMap's GC. Hold WeakRefs and prune dead ones during applyDsp.
const liveGraphs = new Set<WeakRef<MediaAudioGraph>>()
let sharedCtx: AudioContext | null = null
let sharedAnalyser: AnalyserNode | null = null
let settings: DspSettings = { ...DEFAULT_DSP, eqGains: [...DEFAULT_DSP.eqGains] }

function ensureContext(): AudioContext | null {
  if (sharedCtx) return sharedCtx
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  try { sharedCtx = new Ctor() } catch { return null }
  return sharedCtx
}

function tuneAnalyser(a: AnalyserNode) {
  a.fftSize = 512                  // 256 bins → finer frequency resolution
  a.smoothingTimeConstant = 0.55   // less internal smoothing → transients read
  a.minDecibels = -85              // widen the dB window for real contrast
  a.maxDecibels = -12
}

/** The mix-bus analyser (every graph feeds it) - the EQ visualizer's source. */
export function getSharedAnalyser(): AnalyserNode | null {
  return sharedAnalyser
}

const ramp = (param: AudioParam, value: number, actx: AudioContext) => {
  try { param.setTargetAtTime(value, actx.currentTime, 0.05) } catch { param.value = value }
}

function applyToGraph(g: MediaAudioGraph) {
  const actx = sharedCtx
  if (!actx) return
  // EQ bypass = ramp every band to 0dB (no reconnects - biquads at 0 gain are transparent).
  g.eq.forEach((band, i) => ramp(band.gain, settings.eqOn ? (settings.eqGains[i] ?? 0) : 0, actx))
  ramp(g.crossfeedWet.gain, settings.crossfeed ? 0.35 : 0, actx)
  const trim = settings.loudnessOn && g.kind === 'music' ? g.trimDb : 0
  ramp(g.preGain.gain, Math.pow(10, trim / 20), actx)
}

/** Push new DSP settings to every live graph (and all future ones). */
export function applyDsp(next: DspSettings): void {
  settings = { ...next, eqGains: [...next.eqGains] }
  for (const ref of liveGraphs) {
    const g = ref.deref()
    if (g) applyToGraph(g)
    else liveGraphs.delete(ref)   // element was GC'd; drop the dead ref
  }
}

/** Per-element loudness trim (dB). The radio engine sets this per cued track from the
 *  server's LUFS scan; whether it's honored is the loudnessOn setting's call. */
export function setLoudnessTrimDb(el: HTMLMediaElement, db: number): void {
  const g = graphs.get(el)
  if (!g) return
  g.trimDb = db
  applyToGraph(g)
}

/** Get (or build) the element's audio graph. Returns null when Web Audio is unavailable or
 *  the element was already sourced by something outside this module. Also nudges the shared
 *  context out of 'suspended' - safe to call repeatedly. */
export function ensureMediaGraph(el: HTMLMediaElement, opts?: { kind?: 'music' | 'voice' }): MediaAudioGraph | null {
  const actx = ensureContext()
  if (!actx) return null
  void actx.resume?.()
  const existing = graphs.get(el)
  if (existing) return existing
  try {
    const source = actx.createMediaElementSource(el)

    // Loudness trim (pre-EQ so band gains act on a normalized signal).
    const preGain = actx.createGain()

    // 10-band EQ: 9 peaking + a 16k high-shelf, chained in series at 0dB (transparent).
    const eq: BiquadFilterNode[] = EQ_BANDS_HZ.map((hz, i) => {
      const f = actx.createBiquadFilter()
      f.type = i === EQ_BANDS_HZ.length - 1 ? 'highshelf' : 'peaking'
      f.frequency.value = hz
      f.Q.value = 1.1
      f.gain.value = 0
      return f
    })

    // Bauer-style crossfeed: dry passes straight through; the wet path feeds a delayed,
    // low-passed copy of each channel into the OPPOSITE one. Bypass = wet gain 0.
    const cfIn = actx.createGain()
    const cfOut = actx.createGain()
    const splitter = actx.createChannelSplitter(2)
    const merger = actx.createChannelMerger(2)
    const crossfeedWet = actx.createGain()
    crossfeedWet.gain.value = 0
    const mkCross = () => {
      const delay = actx.createDelay(0.005)
      delay.delayTime.value = 0.0003
      const lp = actx.createBiquadFilter()
      lp.type = 'lowpass'; lp.frequency.value = 700
      delay.connect(lp)
      return { head: delay, tail: lp }
    }
    const left = mkCross(), right = mkCross()
    cfIn.connect(cfOut)                              // dry path
    cfIn.connect(splitter)                           // wet taps
    splitter.connect(left.head, 0)                   // L → delayed/lowpassed → R
    left.tail.connect(merger, 0, 1)
    splitter.connect(right.head, 1)                  // R → delayed/lowpassed → L
    right.tail.connect(merger, 0, 0)
    merger.connect(crossfeedWet)
    crossfeedWet.connect(cfOut)

    // Output stage: boost gain, per-element analyser, shared mix-bus analyser.
    const gain = actx.createGain()
    const analyser = actx.createAnalyser()
    tuneAnalyser(analyser)
    if (!sharedAnalyser) { sharedAnalyser = actx.createAnalyser(); tuneAnalyser(sharedAnalyser) }

    source.connect(preGain)
    let head: AudioNode = preGain
    for (const band of eq) { head.connect(band); head = band }
    head.connect(cfIn)
    cfOut.connect(gain)
    gain.connect(actx.destination)  // keep it audible
    gain.connect(analyser)          // parallel read tap (post-gain, so EQ reflects boost)
    gain.connect(sharedAnalyser)    // mix bus

    const graph: MediaAudioGraph = { gain, analyser, kind: opts?.kind ?? 'music', preGain, eq, crossfeedWet, trimDb: 0 }
    graphs.set(el, graph)
    liveGraphs.add(new WeakRef(graph))
    applyToGraph(graph)             // pick up current settings immediately
    return graph
  } catch {
    // Already sourced elsewhere, or Web Audio unsupported.
    return null
  }
}
