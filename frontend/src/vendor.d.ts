// Minimal ambient types for third-party packages that ship no .d.ts.

// noVNC (@novnc/novnc, MPL-2.0), the package's `exports` points at core/rfb.js with no
// bundled types. Only the surface we use in the Homelab Remote Display view.
declare module '@novnc/novnc' {
  export interface RFBCredentials { username?: string; password?: string; target?: string }
  export interface RFBOptions {
    credentials?: RFBCredentials
    shared?: boolean
    repeaterID?: string
    wsProtocols?: string[]
  }
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: RFBOptions)
    scaleViewport: boolean
    resizeSession: boolean
    viewOnly: boolean
    disconnect(): void
  }
}
