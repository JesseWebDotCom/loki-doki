// Companion chat tool: answer "how's this computer doing?", "how much disk space
// is left on my mac?" from the live resource snapshots that Doki Dock installs
// report (lib/monitoring/resources.ts). Read-only; no side effects. Snapshots are
// household-visible — they contain machine health numbers, nothing personal.

import type { Tool, ToolResult } from './index'
import { listFreshSnapshots } from '@/lib/monitoring/resources'

interface Row {
  machine: { id: string; hostname: string; label: string; platform: string }
  snapshot: {
    cpuPct: number | null
    memUsedPct: number | null
    memFreeGb: number
    diskFreePct: number | null
    diskFreeGb: number | null
    battery: { percent: number; charging: boolean } | null
  }
  ageMs: number
}

function summarize(r: Row) {
  const s = r.snapshot
  return {
    machine: r.machine.label,
    platform: r.machine.platform,
    cpuPct: s.cpuPct,
    memUsedPct: s.memUsedPct,
    memFreeGb: s.memFreeGb,
    diskFreePct: s.diskFreePct,
    diskFreeGb: s.diskFreeGb,
    battery: s.battery,
    ageSeconds: Math.round(r.ageMs / 1000),
  }
}

function gistFor(r: Row): string {
  const s = r.snapshot
  const bits: string[] = []
  if (s.cpuPct != null) bits.push(`CPU at ${s.cpuPct}%`)
  if (s.memUsedPct != null) bits.push(`${s.memUsedPct}% memory used`)
  if (s.diskFreeGb != null) bits.push(`${s.diskFreeGb} GB free on disk`)
  if (s.battery) bits.push(`battery ${s.battery.percent}%${s.battery.charging ? ' and charging' : ''}`)
  const issues =
    (s.cpuPct != null && s.cpuPct >= 90) || (s.memUsedPct != null && s.memUsedPct >= 90) ||
    (s.diskFreePct != null && s.diskFreePct <= 10) ||
    (s.battery != null && s.battery.percent <= 15 && !s.battery.charging)
  const lead = issues ? `${r.machine.label} could use attention` : `${r.machine.label} looks healthy`
  return `${lead} — ${bits.join(', ')}.`
}

export const machineStatusTool: Tool = {
  id: 'machineStatus',
  name: 'Computer status',
  description: 'Check the live health of computers running the Doki Dock desktop app — CPU load, memory, free disk space, and battery. Answers "how is this computer doing?", "how much disk space is left?", "is my laptop battery low?".',
  offline: true,
  dataSources: [],
  examples: [
    'how is this computer doing',
    'how much disk space is left on my mac',
    'is my laptop battery low',
    'why is my computer slow',
    'how much memory is my computer using',
    'is my computer running hot',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'machineStatus',
      description: 'Read live CPU / memory / disk / battery stats for computers running the Doki Dock desktop app. Use for questions about a computer\'s health, speed, storage, or battery. Only machines with Doki Dock open report stats.',
      parameters: {
        type: 'object',
        properties: {
          machine: {
            type: 'string',
            description: 'Name/hostname keyword of a specific computer (e.g. "macbook"). Omit to report on every reporting machine.',
          },
        },
      },
    },
  },

  async execute(args: unknown): Promise<ToolResult> {
    const { machine } = (args ?? {}) as { machine?: string }
    const rows = listFreshSnapshots() as Row[]
    if (!rows.length) {
      return {
        success: true,
        data: { answer_payload: { gist: "Doki Dock isn't running on any computer right now, so I can't see live stats. Open the Doki Dock app on the machine you're curious about." } },
      }
    }

    const q = machine?.trim().toLowerCase()
    const matched = q
      ? rows.filter((r) => r.machine.label.toLowerCase().includes(q) || r.machine.hostname.toLowerCase().includes(q))
      : rows
    if (!matched.length) {
      return {
        success: true,
        data: {
          available: rows.map((r) => r.machine.label),
          answer_payload: { gist: `I don't see a computer called "${machine}". Reporting right now: ${rows.map((r) => r.machine.label).join(', ')}.` },
        },
      }
    }

    return {
      success: true,
      data: {
        machines: matched.map(summarize),
        answer_payload: { gist: matched.map(gistFor).join(' ') },
      },
    }
  },
}
