// Screen-awareness intent detection for the desktop shell: when an utterance or
// typed message references what's on screen, the companion attaches a live
// screenshot to the turn (see CompanionEngineContext handleSend). Client-side
// regex so normal turns pay zero latency; only used when window.lokiDesktop
// exposes captureScreen, so web builds never consult it.
//
// Deliberately excludes bare "looking at" ("I'm looking at buying a bike") and
// bare "screen" ("screen time report"). A rare false positive is benign: the
// model just gets a screenshot it may ignore.

export const SCREEN_INTENT_RE = new RegExp(
  [
    /\bmy screen\b/,
    /\bon (my |the )?screen\b/,
    /\bwhat( a|')?m i looking at\b/,
    /\bwhat('s| is) (this|that|it)\b/,
    /\bthis (page|window|tab|error|email|doc(ument)?|code|screen|dialog|popup|message)\b/,
    /\b(read|look at|see|check) (this|the screen|my screen|what i see)\b/,
    /\bcan you see\b/,
  ].map((r) => r.source).join('|'),
  'i',
)

export function matchesScreenIntent(text: string): boolean {
  return SCREEN_INTENT_RE.test(text)
}
