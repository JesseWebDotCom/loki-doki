// Companion chat tool: answer "is Plex down?", "is the internet slow?", "are all my
// services up?" by reading current monitor states from Uptime Kuma (via the same
// /metrics endpoint the integration already uses). Read-only; no side effects.

import type { Tool, ToolResult } from './index'
import { getMonitoringConfig } from '@/lib/monitoring/config'
import { fetchMonitorDetails, type MonitorDetail } from '@/lib/monitoring/kuma'

function fmt(d: MonitorDetail) {
  return { name: d.name, state: d.up ? 'up' : 'down', responseMs: d.responseMs }
}

export const serviceStatusTool: Tool = {
  id: 'serviceStatus',
  name: 'Service status',
  description: 'Check whether home services and servers are up, down, or slow (via Uptime Kuma). Answers questions like "is Plex down?", "is the internet slow?", or "what services are down?".',
  offline: false,
  dataSources: [],
  examples: [
    'is plex down',
    'is the internet down',
    'is the internet slow',
    'is sonarr working',
    'are all my services up',
    'what services are down right now',
    'how is the home server doing',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'serviceStatus',
      description: 'Check the up/down status and response time of home services/servers monitored by Uptime Kuma. Use to answer whether a specific service (Plex, Sonarr, the internet, etc.) is down or slow, or to summarize what is currently down. Response time is in milliseconds — higher means slower.',
      parameters: {
        type: 'object',
        properties: {
          service: {
            type: 'string',
            description: 'Name or keyword of the service to check, e.g. "Plex", "internet", "sonarr". Omit for an overall summary of everything.',
          },
        },
      },
    },
  },

  async execute(args: unknown): Promise<ToolResult> {
    const { service } = (args ?? {}) as { service?: string }
    const cfg = await getMonitoringConfig()
    if (!cfg.baseUrl || !cfg.apiKey) {
      return { success: false, error: 'Service monitoring is not set up yet — add the Uptime Kuma URL and API key in Admin → Integrations → Monitoring.' }
    }

    let details: MonitorDetail[]
    try {
      details = await fetchMonitorDetails(cfg.baseUrl, cfg.apiKey)
    } catch (err) {
      return { success: false, error: `Couldn't reach the monitoring server: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (!details.length) {
      return { success: true, data: { answer_payload: { gist: "There aren't any monitors set up yet." } } }
    }

    // Specific service asked about.
    const q = service?.trim().toLowerCase()
    if (q) {
      const matched = details.filter((d) => d.name.toLowerCase().includes(q))
      if (!matched.length) {
        return {
          success: true,
          data: {
            query: service,
            matched: [],
            available: details.map((d) => d.name),
            answer_payload: { gist: `I don't have a monitor called "${service}". I'm tracking: ${details.map((d) => d.name).join(', ')}.` },
          },
        }
      }
      const d = matched[0]!
      const gist = !d.up
        ? `${d.name} is down right now.`
        : d.responseMs != null
          ? `${d.name} is up, responding in ${d.responseMs} ms.`
          : `${d.name} is up.`
      return { success: true, data: { matched: matched.map(fmt), answer_payload: { gist } } }
    }

    // Overall summary.
    const down = details.filter((d) => !d.up)
    const gist = down.length
      ? `${down.length} of ${details.length} services are down: ${down.map((d) => d.name).join(', ')}.`
      : `All ${details.length} monitored services are up.`
    return { success: true, data: { down: down.map((d) => d.name), all: details.map(fmt), answer_payload: { gist } } }
  },
}
