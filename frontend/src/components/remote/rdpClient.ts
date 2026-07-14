import init, { SessionBuilder, DesktopSize, DeviceEvent, InputTransaction, Extension, RotationUnit, setup, type Session } from 'ironrdp-wasm'
// The wasm binary is vendored into the repo (src/vendor/ironrdp) because ironrdp-wasm's
// package `exports` map only exposes the JS entry, not the .wasm subpath, so it can't be
// deep-imported from node_modules. We pass this URL to init() explicitly.
import wasmUrl from '@/vendor/ironrdp/rdp_client_bg.wasm?url'

// Browser-side RDP via the IronRDP WASM client. The WASM does the full RDP protocol incl.
// NLA/CredSSP; our backend /rdp WS is only the RDCleanPath transport bootstrap. Modeled on
// electerm/ironrdp-wasm's example (session.js + input.js), trimmed to keyboard/mouse/wheel
// (no clipboard/file-transfer). init() is one-shot and cached.

let initPromise: Promise<unknown> | null = null
function ensureInit(): Promise<unknown> {
  if (!initPromise) initPromise = init(wasmUrl).then(() => setup('info'))
  return initPromise
}

// USB HID → RDP scancode map (from the IronRDP example input.js).
const SCANCODE_MAP: Record<string, number> = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06,
  Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b, Minus: 0x0c,
  Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f, KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13,
  KeyT: 0x14, KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19, BracketLeft: 0x1a,
  BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d, KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20,
  KeyF: 0x21, KeyG: 0x22, KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27,
  Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2a, Backslash: 0x2b, KeyZ: 0x2c, KeyX: 0x2d,
  KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32, Comma: 0x33, Period: 0x34,
  Slash: 0x35, ShiftRight: 0x36, NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39,
  CapsLock: 0x3a, F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41,
  F8: 0x42, F9: 0x43, F10: 0x44, NumLock: 0x45, ScrollLock: 0x46, Numpad7: 0x47,
  Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a, Numpad4: 0x4b, Numpad5: 0x4c,
  Numpad6: 0x4d, NumpadAdd: 0x4e, Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52,
  NumpadDecimal: 0x53, F11: 0x57, F12: 0x58, NumpadEnter: 0xe01c, ControlRight: 0xe01d,
  NumpadDivide: 0xe035, PrintScreen: 0xe037, AltRight: 0xe038, Home: 0xe047, ArrowUp: 0xe048,
  PageUp: 0xe049, ArrowLeft: 0xe04b, ArrowRight: 0xe04d, End: 0xe04f, ArrowDown: 0xe050,
  PageDown: 0xe051, Insert: 0xe052, Delete: 0xe053, MetaLeft: 0xe05b, MetaRight: 0xe05c,
  ContextMenu: 0xe05d, Pause: 0xe11d45,
}

function apply(session: Session, event: DeviceEvent): void {
  try {
    const tx = new InputTransaction()
    tx.addEvent(event)
    session.applyInputs(tx)
  } catch { /* transient input errors are non-fatal */ }
}

export interface RdpConnectParams {
  canvas: HTMLCanvasElement
  proxyWsUrl: string
  destination: string // host:port of the RDP server (sent in the RDCleanPath request)
  username: string
  password: string
  domain?: string
}

export interface RdpController { disconnect(): void }

/** Connect and wire input. Resolves once connected; `onEnd` fires when the session stops. */
export async function connectRdp(p: RdpConnectParams, onEnd: (reason: string) => void): Promise<RdpController> {
  await ensureInit()

  const builder = new SessionBuilder()
  builder.username(p.username)
  builder.password(p.password)
  builder.destination(p.destination)
  builder.proxyAddress(p.proxyWsUrl)
  builder.authToken('none')
  builder.serverDomain(p.domain ?? '')
  builder.desktopSize(new DesktopSize(p.canvas.width || 1280, p.canvas.height || 720))
  builder.renderCanvas(p.canvas)
  builder.extension(new Extension('enable_credssp', true))
  builder.setCursorStyleCallbackContext(p.canvas)
  builder.setCursorStyleCallback((style: string) => { p.canvas.style.cursor = style || 'default' })

  const session = await builder.connect()
  const ds = session.desktopSize()
  p.canvas.width = ds.width
  p.canvas.height = ds.height

  const c = p.canvas
  const onKeyDown = (e: KeyboardEvent) => {
    e.preventDefault(); e.stopPropagation()
    const sc = SCANCODE_MAP[e.code]
    if (sc != null) apply(session, DeviceEvent.keyPressed(sc))
  }
  const onKeyUp = (e: KeyboardEvent) => {
    e.preventDefault(); e.stopPropagation()
    const sc = SCANCODE_MAP[e.code]
    if (sc != null) apply(session, DeviceEvent.keyReleased(sc))
  }
  const onMouseMove = (e: MouseEvent) => {
    const rect = c.getBoundingClientRect()
    const x = Math.round((e.clientX - rect.left) * (c.width / rect.width))
    const y = Math.round((e.clientY - rect.top) * (c.height / rect.height))
    apply(session, DeviceEvent.mouseMove(x, y))
  }
  const onMouseDown = (e: MouseEvent) => { e.preventDefault(); c.focus(); apply(session, DeviceEvent.mouseButtonPressed(e.button)) }
  const onMouseUp = (e: MouseEvent) => { e.preventDefault(); apply(session, DeviceEvent.mouseButtonReleased(e.button)) }
  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    if (e.deltaY !== 0) apply(session, DeviceEvent.wheelRotations(true, e.deltaY > 0 ? -1 : 1, RotationUnit.Line))
    if (e.deltaX !== 0) apply(session, DeviceEvent.wheelRotations(false, e.deltaX > 0 ? -1 : 1, RotationUnit.Line))
  }
  const onContextMenu = (e: Event) => e.preventDefault()

  c.addEventListener('keydown', onKeyDown)
  c.addEventListener('keyup', onKeyUp)
  c.addEventListener('mousemove', onMouseMove)
  c.addEventListener('mousedown', onMouseDown)
  c.addEventListener('mouseup', onMouseUp)
  c.addEventListener('wheel', onWheel, { passive: false })
  c.addEventListener('contextmenu', onContextMenu)
  c.focus()

  let stopped = false
  const teardown = () => {
    c.removeEventListener('keydown', onKeyDown)
    c.removeEventListener('keyup', onKeyUp)
    c.removeEventListener('mousemove', onMouseMove)
    c.removeEventListener('mousedown', onMouseDown)
    c.removeEventListener('mouseup', onMouseUp)
    c.removeEventListener('wheel', onWheel)
    c.removeEventListener('contextmenu', onContextMenu)
  }

  session.run()
    .then((info) => { if (!stopped) { stopped = true; teardown(); onEnd(info.reason()) } })
    .catch((e) => { if (!stopped) { stopped = true; teardown(); onEnd(e instanceof Error ? e.message : String(e)) } })

  return {
    disconnect() {
      if (stopped) return
      stopped = true
      try { session.shutdown() } catch { /* already gone */ }
      teardown()
    },
  }
}
