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
  onStatus?: (s: 'connecting' | 'open' | 'closed') => void
}>(function XtermTerminal({ wsUrl, fontSize = 13, onStatus }, ref) {
  const containerRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const focusFn = useRef<(() => void) | null>(null)

  useImperativeHandle(ref, () => ({
    send: (data: string) => { if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(data) },
    focus: () => focusFn.current?.(),
  }))

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      // design-ok(hex-in-tsx): xterm.js renders to a canvas, not the DOM; its theme takes a literal color.
      theme: { background: '#0a0a0a' },
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fit.fit()
    focusFn.current = () => term.focus()

    onStatus?.('connecting')
    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    const sendResize = () => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })) }
    ws.onopen = () => { onStatus?.('open'); sendResize(); term.focus() }
    ws.onmessage = (evt) => {
      if (typeof evt.data === 'string') term.write(evt.data)
      else term.write(new Uint8Array(evt.data as ArrayBuffer))
    }
    ws.onclose = () => onStatus?.('closed')
    ws.onerror = () => onStatus?.('closed')

    const dataSub = term.onData((d) => { if (ws.readyState === WebSocket.OPEN) ws.send(d) })
    const ro = new ResizeObserver(() => { fit.fit(); sendResize() })
    ro.observe(container)

    return () => {
      ro.disconnect()
      dataSub.dispose()
      ws.close()
      term.dispose()
      wsRef.current = null
      focusFn.current = null
    }
  }, [wsUrl, fontSize, onStatus])

  return <div ref={containerRef} className="h-full w-full p-2" />
})
