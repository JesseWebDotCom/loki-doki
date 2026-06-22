import type { Tool, ToolResult } from './index'

export const jokesTool: Tool = {
  id: 'jokes',
  name: 'Jokes',
  description: 'Get a random dad joke',
  offline: false,
  dataSources: [
    { name: 'icanhazdadjoke', domain: 'icanhazdadjoke.com', purpose: 'Random joke generator', type: 'api' },
  ],
  passMessage: null,
  examples: [
    'tell me a joke or make me laugh',
    'say something funny or humorous',
    'deliver a pun, dad joke, or comedy',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'jokes',
      description: 'Fetch a random dad joke',
      parameters: { type: 'object', required: [], properties: {} },
    },
  },

  async execute(_args: unknown): Promise<ToolResult> {
    try {
      const res = await fetch('https://icanhazdadjoke.com/', {
        headers: { Accept: 'application/json', 'User-Agent': 'LokiDoki/1.0' },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return { success: false, error: 'Failed to fetch joke' }
      const data = (await res.json()) as { joke: string; status: number }
      const joke = data.joke?.trim()
      if (!joke) return { success: false, error: 'Empty response' }
      return { success: true, data: { joke, answer_payload: { gist: joke } } }
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        return { success: false, offline: true, error: 'Network unavailable' }
      }
      return { success: false, error: String(err) }
    }
  },
}
