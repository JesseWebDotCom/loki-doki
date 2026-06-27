// Catalog of supported physical voice-satellite devices. Drives the App-Store-style
// cards + the "Add a device" picker, and resolves a stored device.model (e.g. the
// id a device announces over the gateway) into a make/model + art for display.

import type { LucideIcon } from 'lucide-react'
import { Speaker, Tablet, Watch, MonitorSpeaker, Cpu } from 'lucide-react'

export type DeviceStatus = 'supported' | 'beta' | 'coming-soon'

export interface DeviceUsage {
  /** One-line "here's how to use it". */
  headline: string
  /** Short getting-started steps. */
  steps: string[]
  /** What the device's light/screen states mean (color = a tailwind bg-* class). */
  indicators?: { color: string; meaning: string }[]
}

export interface DeviceModel {
  /** Matches device.model / the model a device announces on the gateway. */
  id: string
  make: string
  model: string
  /** Form-factor kind (dot | show | tablet | watch | pod). */
  kind: string
  tagline: string
  icon: LucideIcon
  /** App-Store-style icon background. */
  gradient: string
  /** Optional bundled illustration/photo (under /public/devices). Falls back to the icon. */
  image?: string
  capabilities: string[]
  status: DeviceStatus
  /** Firmware template id the build pipeline uses (only 'atom-echo' is built today). */
  firmware?: string
  /** How-to-use, shown from the device card. Differs per device type. */
  usage?: DeviceUsage
}

// Real, orderable catalog shown in the "Add a device" picker.
export const DEVICE_MODELS: DeviceModel[] = [
  {
    id: 'atom-echo',
    make: 'M5Stack',
    model: 'Atom Echo',
    kind: 'dot',
    tagline: 'Tiny mic + speaker puck with an RGB ring',
    icon: Speaker,
    gradient: 'linear-gradient(135deg,#fb923c,#ea580c)',
    image: '/devices/atom-echo.svg',
    capabilities: ['Mic', 'Speaker', 'RGB LED'],
    status: 'supported',
    firmware: 'atom-echo',
    usage: {
      headline: 'Say “Hey Jarvis”, then ask anything.',
      steps: [
        'It’s always listening for its wake word — no buttons to press.',
        'Say “Hey Jarvis”, pause, then your question (e.g. “what’s the weather?”).',
        'Or hold the top button to talk without the wake word (release when done).',
        'Plug it into any USB power around the house — it reconnects on its own.',
      ],
      indicators: [
        { color: 'bg-amber-500', meaning: 'Amber, breathing — connecting' },
        { color: 'bg-white/70', meaning: 'Dim white — ready, waiting for “Hey Jarvis”' },
        { color: 'bg-emerald-500', meaning: 'Green — listening to you' },
        { color: 'bg-blue-500', meaning: 'Blue — thinking' },
        { color: 'bg-cyan-400', meaning: 'Cyan — speaking' },
      ],
    },
  },
  {
    id: 'tab5',
    make: 'M5Stack',
    model: 'Tab5',
    kind: 'tablet',
    tagline: '5" touchscreen with camera + companion face',
    icon: Tablet,
    gradient: 'linear-gradient(135deg,#6366f1,#8b5cf6)',
    image: '/devices/tab5.svg',
    capabilities: ['Touchscreen', 'Camera', 'Mic', 'Speaker'],
    status: 'supported',
    firmware: 'tab5',
    usage: {
      headline: 'Tap the screen or say “Hey Jarvis”.',
      steps: [
        'Say “Hey Jarvis” hands-free, or tap the screen to talk.',
        'Watch your companion’s face react on the display as it listens and replies.',
        'Stand it on a counter — it stays plugged in for always-on use.',
      ],
    },
  },
]

/** Friendly generic illustration for a device whose model we don't know yet. */
export const GENERIC_DEVICE_IMAGE = '/devices/generic.svg'

// Generic presentation by form-factor for devices not in the catalog (legacy rows,
// manually-created pods). Keeps every card looking intentional.
const KIND_FALLBACK: Record<string, { label: string; icon: LucideIcon; gradient: string }> = {
  dot:    { label: 'Speaker', icon: Speaker,        gradient: 'linear-gradient(135deg,#fb923c,#ea580c)' },
  show:   { label: 'Display', icon: MonitorSpeaker, gradient: 'linear-gradient(135deg,#38bdf8,#0284c7)' },
  tablet: { label: 'Tablet',  icon: Tablet,         gradient: 'linear-gradient(135deg,#6366f1,#8b5cf6)' },
  watch:  { label: 'Watch',   icon: Watch,          gradient: 'linear-gradient(135deg,#34d399,#059669)' },
  pod:    { label: 'Device',  icon: Cpu,            gradient: 'linear-gradient(135deg,#a78bfa,#7c3aed)' },
}

export interface ResolvedDevice {
  make: string | null
  model: string
  icon: LucideIcon
  gradient: string
  image?: string
  capabilities: string[]
}

/** Resolve a device's stored model id (+ kind fallback) into display presentation. */
export function resolveDeviceModel(modelId?: string | null, kind?: string | null): ResolvedDevice {
  const hit = modelId ? DEVICE_MODELS.find((d) => d.id === modelId) : undefined
  if (hit) {
    return { make: hit.make, model: hit.model, icon: hit.icon, gradient: hit.gradient, image: hit.image, capabilities: hit.capabilities }
  }
  const fb = KIND_FALLBACK[kind ?? 'pod'] ?? KIND_FALLBACK.pod!
  // Unknown model → friendly generic illustration so cards never look broken.
  return { make: null, model: fb.label, icon: fb.icon, gradient: fb.gradient, image: GENERIC_DEVICE_IMAGE, capabilities: [] }
}

/** Full display name, e.g. "M5Stack Atom Echo" or just "Speaker" for unknowns. */
export function deviceModelName(modelId?: string | null, kind?: string | null): string {
  const r = resolveDeviceModel(modelId, kind)
  return r.make ? `${r.make} ${r.model}` : r.model
}

const GENERIC_USAGE: DeviceUsage = {
  headline: 'Say “Hey Jarvis”, then ask anything.',
  steps: [
    'It listens for its wake word — no buttons needed.',
    'Say “Hey Jarvis”, pause, then your question.',
    'Keep it powered; it reconnects on its own.',
  ],
  indicators: [
    { color: 'bg-emerald-500', meaning: 'Green — listening' },
    { color: 'bg-blue-500', meaning: 'Blue — thinking' },
    { color: 'bg-cyan-400', meaning: 'Cyan — speaking' },
  ],
}

/** How-to-use for a device, with a friendly generic fallback. */
export function deviceUsage(modelId?: string | null): DeviceUsage {
  return (modelId ? DEVICE_MODELS.find((d) => d.id === modelId)?.usage : undefined) ?? GENERIC_USAGE
}
