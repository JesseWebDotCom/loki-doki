import type { Tool, ToolResult } from './index'
import { zimSearch, deriveZimAnswerPayload } from '@/lib/zimSearch'

const API = 'https://api.dictionaryapi.dev/api/v2/entries/en'

interface Sense { part_of_speech: string; definition: string; example: string }

function deriveAnswerPayload(word: string, senses: Sense[]) {
  if (!senses.length) return { gist: '', highlights: [], sources: [], depth_available: false }
  const primary = senses[0]
  const pos = primary.part_of_speech.trim()
  const def = primary.definition.trim()
  const gist = pos && def ? `"${word}" (${pos}): ${def}` : def ? `"${word}": ${def}` : `"${word}"`
  const highlights = senses.slice(1).filter(s => s.definition).map(s =>
    s.part_of_speech ? `(${s.part_of_speech}) ${s.definition}` : s.definition
  )
  return { gist, highlights, sources: [], depth_available: false }
}

export const dictionaryTool: Tool = {
  id: 'dictionary',
  name: 'Dictionary',
  description: 'Look up word definitions, phonetics, and usage examples',
  offline: false,
  dataSources: [
    { name: 'Free Dictionary API', domain: 'dictionaryapi.dev', purpose: 'Word definitions, phonetics, and usage examples', type: 'api' },
  ],
  examples: [
    'look up the definition or meaning of a word',
    'define a vocabulary word and show usage examples',
    'what does a specific word mean — definition, pronunciation, etymology',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'dictionary',
      description: 'Look up a word definition, pronunciation, and usage examples',
      parameters: {
        type: 'object',
        required: ['word'],
        properties: {
          word: { type: 'string', description: 'Word to look up' },
        },
      },
    },
  },

  async execute(args: unknown): Promise<ToolResult> {
    const { word } = args as { word: string }
    if (!word?.trim()) return { success: false, error: 'Word is required' }
    const q = word.trim()

    // Try Wiktionary ZIM (offline) first
    try {
      const zimResults = await zimSearch(['wiktionary'], q, 3)
      if (zimResults.length > 0) {
        return {
          success: true,
          data: {
            found: true,
            word: q,
            source: 'Wiktionary (offline)',
            results: zimResults,
            answer_payload: deriveZimAnswerPayload(zimResults, q),
          },
        }
      }
    } catch { /* fall through to online API */ }

    try {
      const res = await fetch(`${API}/${encodeURIComponent(q)}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      })
      if (res.status === 404) return { success: true, data: { found: false, word: q, answer_payload: { gist: `"${q}" not found in dictionary.` } } }
      if (!res.ok) return { success: false, error: `API error: ${res.status}` }

      const payload = (await res.json()) as unknown[]
      if (!Array.isArray(payload) || !payload.length) {
        return { success: true, data: { found: false, word: q, answer_payload: { gist: `No definition found for "${q}".` } } }
      }

      const entry = payload[0] as Record<string, unknown>
      const meanings = (entry.meanings ?? []) as Array<Record<string, unknown>>

      const senses: Sense[] = []
      for (const meaning of meanings) {
        const pos = String(meaning.partOfSpeech ?? '')
        const defs = (meaning.definitions ?? []) as Array<Record<string, unknown>>
        for (const d of defs.slice(0, 2)) {
          senses.push({
            part_of_speech: pos,
            definition: String(d.definition ?? '').trim(),
            example: String(d.example ?? '').trim(),
          })
        }
        if (senses.length >= 5) break
      }

      let phonetic = String(entry.phonetic ?? '')
      if (!phonetic) {
        for (const p of (entry.phonetics ?? []) as Array<Record<string, unknown>>) {
          if (p.text) { phonetic = String(p.text); break }
        }
      }

      const finalWord = String(entry.word ?? q)
      return {
        success: true,
        data: {
          found: true,
          word: finalWord,
          phonetic,
          senses,
          answer_payload: deriveAnswerPayload(finalWord, senses),
        },
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        return { success: false, offline: true, error: 'Network unavailable' }
      }
      return { success: false, error: String(err) }
    }
  },
}
