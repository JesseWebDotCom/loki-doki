import { useEffect, useRef } from 'react'
import { startDictation, type DictationSession } from '@/lib/voice/dictation'

// Drives the desktop shell's system-wide dictation hotkey. The shell fires
// `onDictationToggle` on each hotkey press; the first press starts a mic capture,
// the second finalizes it. On finalize we hand the transcript back to the shell,
// which pastes it into whatever app has focus. No-op in a plain browser (the
// bridge method is absent) and only mounted when signed in (STT needs the session).
export function useDesktopDictation(): void {
  const sessionRef = useRef<DictationSession | null>(null)

  useEffect(() => {
    const shell = typeof window !== 'undefined' ? window.lokiDesktop : undefined
    if (!shell?.onDictationToggle || !shell.insertDictation) return

    const insert = shell.insertDictation.bind(shell)

    const off = shell.onDictationToggle(() => {
      // Second press: finalize the utterance in flight.
      if (sessionRef.current) {
        sessionRef.current.stop()
        return
      }
      // First press: start capturing.
      const session = startDictation()
      sessionRef.current = session
      session.done
        .then((text) => {
          const trimmed = text.trim()
          if (trimmed) void insert(trimmed).catch(() => { /* delivery is best-effort */ })
        })
        .catch(() => { /* mic/STT failed to start; nothing to insert */ })
        .finally(() => { sessionRef.current = null })
    })

    return () => {
      off?.()
      sessionRef.current?.cancel()
      sessionRef.current = null
    }
  }, [])
}
