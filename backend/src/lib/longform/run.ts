// Long-form document generation: plan an outline, then write each section grounded
// in retrieved project chunks, assemble to markdown, and persist. Streams progress
// through an emit callback (the route forwards it as SSE). Adapted from v2's
// pipeline_long_form, minus its GBNF grammar (Ollama's JSON format mode is used).

import { randomUUID } from 'node:crypto'
import { db } from '@/db'
import { generatedDocuments } from '@/db/schema'
import { getModel } from '@/lib/models'
import { ollamaChat, ollamaChatStream } from '@/llm/ollama'
import { retrieveChunks, type RetrievedChunk } from '@/lib/rag/retrieve'
import { findPreset, type StudioPreset } from './presets'
import { logger } from '@/lib/logger'

export interface OutlineSection { index: number; title: string; query: string }
export interface Outline { title: string; sections: OutlineSection[] }

export type LongFormEvent =
  | { type: 'start'; preset: string | null }
  | { type: 'outline'; title: string; sections: { index: number; title: string }[] }
  | { type: 'section_start'; index: number; title: string }
  | { type: 'section_token'; index: number; token: string }
  | { type: 'section_done'; index: number; citations: string[] }
  | { type: 'done'; id: string; title: string; markdown: string }
  | { type: 'error'; message: string }

export type Emit = (e: LongFormEvent) => void

const OUTLINE_SCHEMA = {
  type: 'object',
  required: ['title', 'sections'],
  properties: {
    title: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'query'],
        properties: {
          title: { type: 'string' },
          query: { type: 'string', description: 'Search phrase to retrieve source material for this section' },
        },
      },
    },
  },
}

const CITATION_RE = /\[([^\]\n]{1,80}?)\]/g

function sourceDigest(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return '(no documents attached — write from general knowledge)'
  return chunks
    .map((c) => `- ${c.filename} (${c.loc ?? '?'}): ${c.text.slice(0, 160).replace(/\s+/g, ' ')}…`)
    .join('\n')
}

function sourceMaterial(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return ''
  return chunks.map((c) => `[${c.filename}${c.loc ? ` ${c.loc}` : ''}]\n${c.text}`).join('\n\n---\n\n')
}

async function planOutline(
  model: string,
  userText: string,
  preset: StudioPreset | null,
  digest: string,
): Promise<Outline> {
  const system = [
    'You are an expert writing planner. Produce a JSON outline for a document.',
    preset?.plannerPrompt ?? '',
    `Aim for about ${preset?.defaultSectionCount ?? 5} sections unless the request clearly needs more or fewer.`,
    'Each section needs a "title" and a "query" (a short phrase used to fetch relevant source passages).',
  ].filter(Boolean).join(' ')

  const user = `Request: ${userText}\n\nAvailable source material:\n${digest}`

  const res = await ollamaChat(
    model,
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    undefined,
    { temperature: 0.2 },
    OUTLINE_SCHEMA,
  )
  const raw = res.message?.content ?? '{}'
  let parsed: { title?: string; sections?: Array<{ title?: string; query?: string }> }
  try { parsed = JSON.parse(raw) } catch { throw new Error('Planner returned invalid JSON') }

  const sections = (parsed.sections ?? [])
    .filter((s) => s.title?.trim())
    .map((s, i) => ({ index: i, title: s.title!.trim(), query: (s.query ?? s.title)!.trim() }))
  if (sections.length === 0) throw new Error('Planner produced no sections')

  return { title: parsed.title?.trim() || userText.slice(0, 80), sections }
}

const SECTION_SYSTEM =
  'You are writing one section of a longer document. Write clear, well-structured markdown for this ' +
  'section only — do not repeat the document title or other sections. Ground every claim in the provided ' +
  'source material and cite it inline as [filename]. If the sources do not cover something, say so briefly.'

export interface RunLongFormParams {
  projectId: string
  userId: string
  conversationId?: string | null
  userText: string
  presetId?: string | null
  model?: string
  signal?: { readonly aborted: boolean }
}

export async function runLongForm(p: RunLongFormParams, emit: Emit): Promise<void> {
  const preset = findPreset(p.presetId)
  emit({ type: 'start', preset: preset?.id ?? null })

  const model = p.model ?? (await getModel())

  try {
    // Source digest for the planner (broad retrieve against the overall request).
    const { chunks: digestChunks } = await retrieveChunks(p.projectId, p.userText, 8)
    const outline = await planOutline(model, p.userText, preset, sourceDigest(digestChunks))
    emit({ type: 'outline', title: outline.title, sections: outline.sections.map((s) => ({ index: s.index, title: s.title })) })

    const generated: { title: string; body: string }[] = []

    for (const section of outline.sections) {
      if (p.signal?.aborted) return
      emit({ type: 'section_start', index: section.index, title: section.title })

      const { chunks } = await retrieveChunks(p.projectId, `${section.title} ${section.query}`, 5)
      const material = sourceMaterial(chunks)
      const userPrompt =
        `Document: ${outline.title}\nSection to write: ${section.title}\n\nOverall request: ${p.userText}\n\n` +
        (material ? `Source material:\n${material}` : 'No source material — use general knowledge and note that.')

      let body = ''
      for await (const chunk of ollamaChatStream(model, [
        { role: 'system', content: SECTION_SYSTEM },
        { role: 'user', content: userPrompt },
      ], { temperature: 0.4 })) {
        if (p.signal?.aborted) return
        const tok = chunk.message?.content ?? ''
        if (tok) { body += tok; emit({ type: 'section_token', index: section.index, token: tok }) }
      }

      const citations = [...new Set([...body.matchAll(CITATION_RE)].map((m) => m[1]!.trim()))]
      emit({ type: 'section_done', index: section.index, citations })
      generated.push({ title: section.title, body: body.trim() })
    }

    const markdown =
      `# ${outline.title}\n\n` +
      generated.map((s) => `## ${s.title}\n\n${s.body}`).join('\n\n')

    const id = randomUUID()
    await db.insert(generatedDocuments).values({
      id,
      projectId: p.projectId,
      conversationId: p.conversationId ?? null,
      userId: p.userId,
      title: outline.title,
      preset: preset?.id ?? null,
      markdown,
      createdAt: new Date(),
    })

    emit({ type: 'done', id, title: outline.title, markdown })
  } catch (e) {
    logger.warn(`[longform] generation failed: ${e}`)
    emit({ type: 'error', message: (e as Error).message })
  }
}
