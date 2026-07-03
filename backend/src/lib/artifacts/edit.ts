// LLM-driven "ask the assistant to edit the canvas" — the companion-editing half of
// the Canvas feature ("make it shorter", "add error handling", "translate to French").
// Deliberately self-contained (its own endpoint, not the chat/turn pipeline) so the
// pane can drive edits directly without threading a focused-artifact through routing.

import { ollamaChat } from '@/llm/ollama'
import { getModel } from '@/lib/models'
import type { ArtifactRow } from '@/lib/artifacts/store'

function systemFor(art: ArtifactRow): string {
  if (art.type === 'code') {
    return `You are a precise code editor. You receive a code file and an instruction. Apply it and return ONLY the FULL updated code — no markdown code fences, no prose, no explanation. Preserve working code you weren't asked to change.`
  }
  if (art.type === 'html') {
    return `You are a precise web-page editor. You receive a complete, self-contained HTML document and an instruction. Apply it and return ONLY the FULL updated HTML document (inline CSS/JS, no external resources) — no markdown code fences, no prose.`
  }
  return `You are a precise document editor. You receive a Markdown document and an instruction (e.g. shorten, rewrite, make more formal, translate, add a section). Apply it and return ONLY the FULL updated document as clean Markdown — no surrounding code fences, no preamble, no commentary.`
}

/** Run one edit pass over the artifact's current content; returns the new content
 *  (caller persists it as a new version). Throws on model/timeout failure. */
export async function editArtifactContent(art: ArtifactRow, instruction: string): Promise<string> {
  const model = (await getModel())
  const res = await ollamaChat(
    model,
    [
      { role: 'system', content: systemFor(art) },
      { role: 'user', content: `Instruction: ${instruction.trim()}\n\nCurrent ${art.type}:\n${art.currentContent}` },
    ],
    undefined,
    { temperature: 0.3, num_predict: 4096 },
    undefined,
    120_000,
  )
  let out = (res.message.content ?? '').trim()
  // Strip a single wrapping code fence if the model added one despite instructions.
  const m = out.match(/^```[^\n]*\n([\s\S]*?)\n?```$/)
  if (m) out = m[1]!
  if (!out) throw new Error('The editor returned nothing')
  return out
}
