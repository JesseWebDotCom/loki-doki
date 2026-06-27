// Discovered-but-unclaimed Pods. A screenless device (e.g. the Atom Echo) can't
// show or accept a typed pairing code, so on first boot — after Wi-Fi but before
// it owns a token — it announces itself to the gateway with a stable hardware id
// (MAC). The session registers here as "discoverable"; the admin panel lists these
// and Claims one, which mints a token and pushes it back down the open socket.
//
// This is intentionally in-memory and ephemeral: a device is only claimable while
// its socket is live (so the token can be delivered immediately). When the socket
// closes, the entry is removed.

export interface PendingDevice {
  /** Stable hardware id the device reported (MAC). The map key. */
  hwid: string
  /** Device model/kind hint, e.g. "atom-echo" (for nicer admin labels). */
  model: string | null
  /** Capabilities the device advertised (screen/camera/sampleRate…). */
  caps: unknown
  /** Epoch ms the device first announced itself this session. */
  firstSeen: number
  /**
   * Bind the just-minted credentials to the waiting socket: push the token to the
   * device (it persists to flash) and authenticate the live session in place, so
   * the device is usable immediately without a reconnect.
   */
  claim: (deviceId: string, token: string) => void | Promise<void>
}

const pending = new Map<string, PendingDevice>()

export function addPending(d: PendingDevice): void {
  pending.set(d.hwid, d)
}

export function removePending(hwid: string): void {
  pending.delete(hwid)
}

export function getPending(hwid: string): PendingDevice | undefined {
  return pending.get(hwid)
}

/** Snapshot for the admin "Unclaimed devices nearby" list (no callbacks leaked). */
export function listPending(): Array<{ hwid: string; model: string | null; firstSeen: number }> {
  return [...pending.values()].map(({ hwid, model, firstSeen }) => ({ hwid, model, firstSeen }))
}
