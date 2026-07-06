// Auto-fills a search input from the clipboard the moment the user focuses it — but only
// when the field is empty and the clipboard actually looks like something worth pasting.
// navigator.clipboard.readText() requires a user gesture (reading on mount throws/denies
// silently in most browsers), so this must run from the input's own 'focus' event, never
// on mount.
import { useEffect, type RefObject } from 'react'

const URL_RE = /^https?:\/\/\S+$/i
// A "plausible search query": short-ish, printable, at least one word character.
const QUERY_RE = /^[^\x00-\x1f\x7f]{2,200}$/

function looksPastable(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return URL_RE.test(t) || (QUERY_RE.test(t) && /\w/.test(t))
}

/**
 * @param inputRef  the search input to watch
 * @param onFill    called with the clipboard text when it should be autofilled
 * @param enabled   set false to skip wiring up the focus listener entirely (e.g. when this
 *                  input is shared across apps and autofill should only apply to some of them)
 */
export function useClipboardAutofill(
  inputRef: RefObject<HTMLInputElement | null>,
  onFill: (text: string) => void,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled) return
    const el = inputRef.current
    if (!el) return

    const onFocus = () => {
      if (el.value) return
      void (async () => {
        try {
          const text = await navigator.clipboard.readText()
          if (!el.value && text && looksPastable(text)) onFill(text)
        } catch {
          // Clipboard permission denied/unsupported — fail silently, no autofill.
        }
      })()
    }

    el.addEventListener('focus', onFocus)
    return () => el.removeEventListener('focus', onFocus)
  }, [inputRef, onFill, enabled])
}
