// Cross-tab voice ownership — "focus-follows-tab" leader election.
//
// With the site open in several browser tabs, only ONE companion should hold the
// mic (hands-free) and play TTS at a time — otherwise tabs fight over getUserMedia
// and you hear overlapping voices. This module elects a single owner: the
// most-recently focused/visible tab that actually wants voice (hands-free or
// read-aloud enabled). When you switch tabs, the newly-visible tab claims
// ownership and the previous owner yields (stopping its mic + audio).
//
// Mechanism: a BroadcastChannel carries claim/heartbeat/release messages. A claim
// is optimistic (the claimer becomes owner locally at once, then announces it);
// peers yield on receipt. The owner heartbeats every HEARTBEAT_MS so a crashed or
// closed owner goes stale and a remaining visible tab can take over — this is the
// liveness backstop that a plain `release` on close can't guarantee.
//
// Consumers gate the mic/TTS chokepoints on `getIsVoiceOwner()` / `useVoiceOwner()`
// and declare intent via `setVoiceWants()`. Where BroadcastChannel is unavailable
// the module degrades to always-owner (current single-tab behaviour).

import { useEffect, useState } from 'react'
import { uuid } from '@/lib/uuid'

const CHANNEL = 'companion-voice-ownership'
const HEARTBEAT_MS = 2000
// Owner is considered dead after missing ~2 heartbeats; a visible tab then claims.
const STALE_MS = 5000

type Msg =
  | { type: 'claim'; tabId: string; ts: number }
  | { type: 'heartbeat'; tabId: string; ts: number }
  | { type: 'release'; tabId: string }

const tabId = uuid()

let channel: BroadcastChannel | null = null
let started = false
let supported = false

let isOwner = false
let wantsVoice = false
let ownerTabId: string | null = null
let myClaimTs = 0
let lastOwnerHeartbeat = 0
let tickTimer: ReturnType<typeof setInterval> | null = null

const listeners = new Set<(owner: boolean) => void>()

function now(): number {
  return Date.now()
}

function isVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible'
}

function setOwner(next: boolean): void {
  if (isOwner === next) return
  isOwner = next
  listeners.forEach((fn) => fn(next))
}

function post(msg: Msg): void {
  try {
    channel?.postMessage(msg)
  } catch {
    /* channel closed */
  }
}

/** Take ownership now (optimistic) and announce it to peers. */
function claim(): void {
  if (!wantsVoice) return
  myClaimTs = now()
  ownerTabId = tabId
  lastOwnerHeartbeat = myClaimTs
  setOwner(true)
  post({ type: 'claim', tabId, ts: myClaimTs })
}

/** Give up ownership and let any other willing tab take over. */
function release(): void {
  if (ownerTabId === tabId) ownerTabId = null
  if (isOwner) {
    setOwner(false)
    post({ type: 'release', tabId })
  }
}

function ownerIsStale(): boolean {
  return ownerTabId === null || now() - lastOwnerHeartbeat > STALE_MS
}

function onMessage(ev: MessageEvent<Msg>): void {
  const msg = ev.data
  if (!msg || typeof msg !== 'object') return
  switch (msg.type) {
    case 'claim': {
      // Our own newer claim wins (tiebreak equal timestamps by tab id) — ignore.
      if (msg.tabId !== tabId && (msg.ts < myClaimTs || (msg.ts === myClaimTs && msg.tabId < tabId))) return
      ownerTabId = msg.tabId
      lastOwnerHeartbeat = now()
      setOwner(msg.tabId === tabId)
      break
    }
    case 'heartbeat': {
      if (msg.tabId === ownerTabId || ownerTabId === null) {
        ownerTabId = msg.tabId
        lastOwnerHeartbeat = now()
        if (msg.tabId !== tabId) setOwner(false)
      }
      break
    }
    case 'release': {
      if (msg.tabId === ownerTabId) {
        ownerTabId = null
        lastOwnerHeartbeat = 0
        // Instant handoff: the visible willing tab grabs it.
        if (wantsVoice && isVisible()) claim()
      }
      break
    }
  }
}

function tick(): void {
  if (isOwner) {
    post({ type: 'heartbeat', tabId, ts: now() })
  } else if (wantsVoice && isVisible() && ownerIsStale()) {
    // Owner went away without releasing (crash/close); reclaim.
    claim()
  }
}

function start(): void {
  if (started) return
  started = true
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
    // No cross-tab coordination available: behave as the sole owner.
    supported = false
    setOwner(true)
    return
  }
  supported = true
  channel = new BroadcastChannel(CHANNEL)
  channel.onmessage = onMessage
  window.addEventListener('visibilitychange', () => {
    if (isVisible() && wantsVoice && !isOwner) claim()
  })
  window.addEventListener('focus', () => {
    if (wantsVoice && !isOwner) claim()
  })
  window.addEventListener('pagehide', () => release())
  tickTimer = setInterval(tick, HEARTBEAT_MS)
}

/**
 * Declare whether this tab wants the companion voice (hands-free or read-aloud
 * is on for an active character). Becoming willing while visible claims
 * ownership; becoming unwilling releases it.
 */
export function setVoiceWants(want: boolean): void {
  start()
  if (wantsVoice === want) return
  wantsVoice = want
  if (!supported) return
  if (want) {
    if (isVisible() || ownerIsStale()) claim()
  } else {
    release()
  }
}

export function getIsVoiceOwner(): boolean {
  start()
  return isOwner
}

/** Whether this tab currently wants voice (hands-free or read-aloud armed). Used by the
 *  browser-session stream's keepWhenHidden so a hidden hands-free tab stays connected and
 *  hears dock arbitration changes (it needs connectivity for STT anyway). */
export function getVoiceWants(): boolean {
  return wantsVoice
}

/** Subscribe to ownership changes; fires immediately with the current value. */
export function onOwnershipChange(fn: (owner: boolean) => void): () => void {
  start()
  listeners.add(fn)
  fn(isOwner)
  return () => {
    listeners.delete(fn)
  }
}

export function useVoiceOwner(): boolean {
  const [owner, setO] = useState(() => getIsVoiceOwner())
  useEffect(() => onOwnershipChange(setO), [])
  return owner
}

// Exposed for teardown in tests; not used in the app lifecycle (tabs live until
// closed, where `pagehide` releases ownership).
export function _stopVoiceOwnership(): void {
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = null
  channel?.close()
  channel = null
  started = false
}
