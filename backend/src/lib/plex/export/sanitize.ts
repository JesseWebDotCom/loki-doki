// Filename/foldername sanitization for the Plex export tree. No reusable NTFS-illegal-
// character sanitizer exists elsewhere in this codebase — the handful of existing regexes
// (routes/youtube.ts, routes/chat.ts, routes/adminImageLoras.ts: `[^\w.\- ]+`) are ad hoc
// allow-lists, not the real Windows-illegal set, and don't handle reserved device names.

const ILLEGAL_CHARS = /[<>:"/\\|?*\x00-\x1f]/g
const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])
const MAX_LEN = 150 // conservative — leaves headroom under Windows' 260-char full-path limit

/** Make a string safe to use as a single Windows/NTFS path SEGMENT (not a full path — call
 *  once per folder/file name, never on a string containing separators you want to keep). */
export function sanitizeFilename(name: string): string {
  let out = name
    .replace(ILLEGAL_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '') // trailing dots/spaces are silently stripped by Windows and can
                            // cause a folder to mismatch what was just created
  if (!out) out = '_'
  if (RESERVED_NAMES.has(out.toUpperCase())) out = `_${out}`
  if (out.length > MAX_LEN) out = out.slice(0, MAX_LEN).trim()
  return out
}
