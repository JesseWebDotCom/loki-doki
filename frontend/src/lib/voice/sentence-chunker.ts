// Lightweight sentence splitter used by the playback client to decide whether a
// request is single-sentence (buffer + play) or multi-sentence (stream-enqueue).
// The backend does the authoritative segmentation; this is just a count hint.

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}
