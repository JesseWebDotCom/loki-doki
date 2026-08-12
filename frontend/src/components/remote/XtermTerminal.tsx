import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export interface XtermHandle {
  /** Send raw text into the session (used by snippets). */
  send: (data: string) => void
  focus: () => void
}

// "closed" is terminal: the server refused us (4400-4499 close = auth/token/feature
// refusal) where retrying would just be refused again. Transport drops (backend
// restart, network blip, phone sleeping) go through "reconnecting" and retry
// automatically: the host-shell/claude-code sessions live in the PTY sidecar and
// survive the drop, replaying their scrollback ring on reattach; an SSH pane gets
// a fresh login shell. Same pattern as CodingPage.tsx.
export type TerminalStatus = 'connecting' | 'open' | 'reconnecting' | 'closed'

// Reusable xterm.js ↔ WebSocket terminal. The server treats any JSON text frame as a control
// message ({type:'resize',cols,rows}) and everything else as raw input; binary frames (SSH
// stdout) are written straight through. Reconnects on transport drops; a changed `wsUrl`
// tears down and starts over.
export const XtermTerminal = forwardRef<XtermHandle, {
  wsUrl: string
  fontSize?: number
  /** True while this terminal's tab is the visible one; re-fits + focuses when it flips true. */
  active?: boolean
  onStatus?: (s: TerminalStatus) => void
}>(function XtermTerminal({ wsUrl, fontSize = 13, active = true, onStatus }, ref) {
  const containerRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const refitRef = useRef<() => void>(() => {})

  useImperativeHandle(ref, () => ({
    send: (data: string) => { if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(data) },
    focus: () => termRef.current?.focus(),
  }))

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize,
      // "Symbols Nerd Font Mono" (unicode-range-scoped @font-face in index.css) is the per-glyph
      // fallback that renders Oh My Posh / powerline / Nerd Font icons; latin text stays in the
      // system monospace before it.
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Symbols Nerd Font Mono", monospace',
      // design-ok(hex-in-tsx): xterm.js renders to a canvas, not the DOM; its theme takes a literal color.
      theme: { background: '#0a0a0a' },
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    termRef.current = term

    // The Nerd Font symbol face is fetched lazily (unicode-range) and xterm's canvas won't reflow
    // on a font swap by itself, so a powerline prompt would show tofu until the next redraw. Kick
    // the load when the terminal opens (U+E0B0 is inside the @font-face range, so a latin test
    // string would not trigger it) and repaint once it's ready.
    document.fonts?.load(`${fontSize}px "Symbols Nerd Font Mono"`, '')
      .then(() => { try { term.refresh(0, term.rows - 1) } catch { /* disposed */ } })
      .catch(() => { /* font unavailable; fall back silently */ })

    let disposed = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let attempts = 0

    const sendResize = () => {
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }
    // Re-measure the terminal against its container and tell the server the new size. Guarded
    // because fit() throws if the element has no layout box (e.g. a not-yet-laid-out flex child).
    const refit = () => { try { fit.fit() } catch { /* no layout box yet */ } sendResize() }
    refitRef.current = refit

    onStatus?.('connecting')
    const connect = () => {
      const ws = new WebSocket(wsUrl)
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws

      ws.onopen = () => {
        if (disposed || wsRef.current !== ws) return
        // A REconnect replays the whole session ring (host shell / claude code) or
        // starts a fresh shell (ssh), so reset first: the replay must not append
        // onto stale screen content.
        if (attempts > 0) { try { term.reset() } catch { /* disposed */ } }
        attempts = 0
        onStatus?.('open')
        refit()
        if (active) term.focus()
      }
      ws.onmessage = (evt) => {
        if (typeof evt.data === 'string') term.write(evt.data)
        else term.write(new Uint8Array(evt.data as ArrayBuffer))
      }
      // No onerror handler: a failed socket always fires close as well, so close is
      // the single place drops are handled (an error-only handler would double-fire).
      ws.onclose = (evt) => {
        if (disposed || wsRef.current !== ws) return
        // 44xx closes are deliberate refusals (expired session/token, feature off,
        // no capability); retrying would loop against the same refusal.
        if (evt.code >= 4400 && evt.code < 4500) { onStatus?.('closed'); return }
        onStatus?.('reconnecting')
        retryTimer = setTimeout(connect, Math.min(15_000, 1_000 * 2 ** attempts))
        attempts++
      }
    }
    connect()

    // A background phone/tablet tab gets its timers throttled; on returning to the
    // app, reconnect immediately instead of waiting out a long backoff.
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || disposed) return
      const ws = wsRef.current
      if (ws && ws.readyState !== WebSocket.CLOSED) return
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
      connect()
    }
    document.addEventListener('visibilitychange', onVisible)

    // The container is a flex child, so its final height isn't known on the synchronous mount
    // pass; fitting only then leaves rows short and clips the first lines. Fit again after the
    // browser has laid out (rAF), which is when the real height is available.
    const raf = requestAnimationFrame(() => { refit(); if (active) term.focus() })

    const dataSub = term.onData((d) => { const ws = wsRef.current; if (ws?.readyState === WebSocket.OPEN) ws.send(d) })
    const ro = new ResizeObserver(() => refit())
    ro.observe(container)

    return () => {
      disposed = true
      if (retryTimer) clearTimeout(retryTimer)
      document.removeEventListener('visibilitychange', onVisible)
      cancelAnimationFrame(raf)
      ro.disconnect()
      dataSub.dispose()
      try { wsRef.current?.close() } catch { /* already closed */ }
      term.dispose()
      wsRef.current = null
      termRef.current = null
      refitRef.current = () => {}
    }
    // `active` is deliberately NOT a dependency: it's only read for initial focus,
    // and including it would tear down the live socket on every tab switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsUrl, fontSize, onStatus])

  // When this tab becomes the active one, its pane flips from hidden to visible; re-fit against
  // the now-laid-out size and take focus so the cursor is the solid blinking block (an unfocused
  // xterm shows a hollow, non-blinking box).
  useEffect(() => {
    if (!active) return
    const id = requestAnimationFrame(() => { refitRef.current(); termRef.current?.focus() })
    return () => cancelAnimationFrame(id)
  }, [active])

  return <div ref={containerRef} className="h-full w-full p-2" />
})
