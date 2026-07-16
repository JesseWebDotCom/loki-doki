import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export interface XtermHandle {
  /** Send raw text into the session (used by snippets). */
  send: (data: string) => void
  focus: () => void
}

// Reusable xterm.js ↔ WebSocket terminal. The server treats any JSON text frame as a control
// message ({type:'resize',cols,rows}) and everything else as raw input; binary frames (SSH
// stdout) are written straight through. Reconnects whenever `wsUrl` changes.
export const XtermTerminal = forwardRef<XtermHandle, {
  wsUrl: string
  fontSize?: number
  /** True while this terminal's tab is the visible one; re-fits + focuses when it flips true. */
  active?: boolean
  onStatus?: (s: 'connecting' | 'open' | 'closed') => void
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
    document.fonts?.load(`${fontSize}px "Symbols Nerd Font Mono"`, '')
      .then(() => { try { term.refresh(0, term.rows - 1) } catch { /* disposed */ } })
      .catch(() => { /* font unavailable; fall back silently */ })

    onStatus?.('connecting')
    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    const sendResize = () => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })) }
    // Re-measure the terminal against its container and tell the server the new size. Guarded
    // because fit() throws if the element has no layout box (e.g. a not-yet-laid-out flex child).
    const refit = () => { try { fit.fit() } catch { /* no layout box yet */ } sendResize() }
    refitRef.current = refit

    // The container is a flex child, so its final height isn't known on the synchronous mount
    // pass; fitting only then leaves rows short and clips the first lines. Fit again after the
    // browser has laid out (rAF), which is when the real height is available.
    const raf = requestAnimationFrame(() => { refit(); if (active) term.focus() })

    ws.onopen = () => { onStatus?.('open'); refit(); term.focus() }
    ws.onmessage = (evt) => {
      if (typeof evt.data === 'string') term.write(evt.data)
      else term.write(new Uint8Array(evt.data as ArrayBuffer))
    }
    ws.onclose = () => onStatus?.('closed')
    ws.onerror = () => onStatus?.('closed')

    const dataSub = term.onData((d) => { if (ws.readyState === WebSocket.OPEN) ws.send(d) })
    const ro = new ResizeObserver(() => refit())
    ro.observe(container)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      dataSub.dispose()
      ws.close()
      term.dispose()
      wsRef.current = null
      termRef.current = null
      refitRef.current = () => {}
    }
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
