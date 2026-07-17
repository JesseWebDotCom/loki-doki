// Listening Together: hand a `together` command off from the browser-session SSE
// stream (useBrowserSession, which owns the connection) to the component that holds
// the player contexts (TogetherRemoteReceiver). Keeps the SSE hook free of player
// wiring, and keeps command execution in a place that can only reach the contexts'
// public APIs.

import type { TogetherCommand } from '@/lib/together/api'

/** Returns true when the command actually produced its effect (gates the ack). */
export type TogetherHandler = (cmd: TogetherCommand) => Promise<boolean>

let handler: TogetherHandler | null = null

export function registerTogetherHandler(fn: TogetherHandler): () => void {
  handler = fn
  return () => { if (handler === fn) handler = null }
}

export async function dispatchTogetherCommand(cmd: TogetherCommand): Promise<boolean> {
  if (!handler) return false
  try { return await handler(cmd) } catch { return false }
}

export function parseTogetherCommand(raw: unknown): TogetherCommand | null {
  if (!raw || typeof raw !== 'object') return null
  const kind = (raw as { kind?: unknown }).kind
  if (typeof kind !== 'string') return null
  return raw as TogetherCommand
}
