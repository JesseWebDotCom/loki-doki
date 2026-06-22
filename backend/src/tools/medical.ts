import type { Tool, ToolResult } from './index'
import { zimSearch, deriveZimAnswerPayload } from '@/lib/zimSearch'
import { searchTool } from './search'

export const medicalTool: Tool = {
  id: 'medical',
  name: 'Medical Reference',
  description:
    'Look up medical conditions, symptoms, treatments, drugs, and health information. Uses offline WikiMed when installed.',
  offline: false,
  dataSources: [
    { name: 'DuckDuckGo', domain: 'duckduckgo.com', purpose: 'Medical reference search (fallback when offline library is not installed)', type: 'api' },
  ],
  passMessage: 'query',
  examples: [
    'what are the symptoms of a disease or medical condition',
    'how is a condition or illness diagnosed or treated',
    'what does a medical term or diagnosis mean',
    'drug interactions, dosage, or medication side effects',
    'what causes a specific condition or health problem',
    'is a symptom serious or a sign of a disease',
    'medical explanation of a body part, process, or condition',
    'health information about nutrition, pregnancy, or chronic illness',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'medical',
      description:
        'Look up medical conditions, symptoms, treatments, drugs, and health information',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Medical question or term to look up' },
        },
      },
    },
  },

  async execute(args: unknown): Promise<ToolResult> {
    const { query } = args as { query: string }
    if (!query?.trim()) return { success: false, error: 'Query is required' }

    const q = query.trim()

    // WikiMed first (offline), then Wikipedia, then fall back to web search
    try {
      const zimResults = await zimSearch(['wikimed', 'wikipedia'], q, 5)
      if (zimResults.length > 0) {
        const source =
          zimResults[0].sourceId === 'wikimed' ? 'WikiMed (offline)' : 'Wikipedia (offline)'
        return {
          success: true,
          data: {
            source,
            results: zimResults,
            answer_payload: deriveZimAnswerPayload(zimResults, q),
          },
        }
      }
    } catch { /* ZIM unavailable — fall through */ }

    return searchTool.execute({ query: q, max_results: 5 })
  },
}
