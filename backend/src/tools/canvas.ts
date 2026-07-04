import type { Tool, ToolResult } from './index'
import { createArtifact, getArtifact, type ArtifactType } from '@/lib/artifacts/store'
import { logger } from '@/lib/logger'

// Canvas tool: the companion produces a single, self-contained, reusable artifact —
// a code snippet, a markdown document, or a small HTML page — into an editable side
// pane (ChatGPT Canvas / Claude Artifacts), instead of dumping it inline in the chat
// (where it also gets read aloud). This tool ONLY opens the artifact and returns its
// metadata; the body is written by the normal LLM synthesis pass, which the turn
// pipeline tees into `artifact_token` events (see companionTurn.ts) so it streams
// live into the pane and is persisted as the artifact's first version.
//
// NOT for multi-file projects / "build me an app" — those route to the `coding`
// tool (the sandboxed Claude Code workspace). Canvas is the lightweight single-file surface.

interface CanvasArgs {
  type?: string
  title?: string
  language?: string
  // Edit mode (set by the focused-canvas override in companionTurn, not the model):
  editArtifactId?: string
  instruction?: string
}

function normalizeType(raw: unknown): ArtifactType {
  const t = String(raw ?? '').toLowerCase().trim()
  if (t === 'code') return 'code'
  if (t === 'html' || t === 'webpage' || t === 'web page' || t === 'page') return 'html'
  return 'document'
}

function outputRuleFor(type: ArtifactType, language?: string | null): string {
  return type === 'code'
    ? `Output ONLY the raw ${language ? language + ' ' : ''}code — no markdown code fences, no prose, no explanation.`
    : type === 'html'
      ? 'Output ONLY a complete, self-contained HTML document (inline CSS/JS, no external resources) — no markdown code fences, no prose.'
      : 'Output ONLY the document itself as clean Markdown — no code fences around the whole thing, no preamble, no meta commentary.'
}

async function execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
  const { type, title, language, editArtifactId, instruction } = (args ?? {}) as CanvasArgs
  const userId = config?._userId as string | undefined
  if (!userId) return { success: false, error: 'Canvas needs a signed-in user.' }

  // ── Edit mode ────────────────────────────────────────────────────────────────
  // Rewrite an EXISTING artifact per the user's instruction. The synthesis pass is
  // the updated body (teed into the same artifact/pane as a new version by the turn
  // pipeline). Reuses the open_artifact directive to reopen the pane if it was closed.
  if (editArtifactId) {
    const art = await getArtifact(editArtifactId, userId)
    if (!art) return { success: false, error: "I couldn't find that canvas to edit." }
    const kindWord = art.type === 'code' ? 'code' : art.type === 'html' ? 'HTML page' : 'document'
    return {
      success: true,
      data: { artifactId: art.id, artifactType: art.type, title: art.title, edited: true },
      directive: { action: 'open_artifact', artifactId: art.id, artifactType: art.type, title: art.title },
      synthesisHint: `Here is the current ${kindWord} titled "${art.title}":\n\n${art.currentContent}\n\nApply this change: ${(instruction ?? '').trim()}\n\nReturn the FULL updated ${kindWord} with the change applied. ${outputRuleFor(art.type, art.language)}`,
    }
  }

  const artifactType = normalizeType(type)
  const cleanTitle = (title?.trim() || 'Untitled').slice(0, 120)
  // conversationId is the turn's convId; may be a synthetic off-chat id (e.g.
  // "pod:<userId>") or absent — the store accepts null.
  const rawConvId = config?._conversationId as string | undefined
  const conversationId = rawConvId && !rawConvId.includes(':') ? rawConvId : null

  let artifactId: string
  try {
    const row = await createArtifact({
      userId,
      type: artifactType,
      title: cleanTitle,
      language: language?.trim() || (artifactType === 'document' ? 'markdown' : null),
      conversationId,
    })
    artifactId = row.id
  } catch (err) {
    logger.warn(`[canvas] create failed: ${err}`)
    return { success: false, error: 'Could not open the canvas.' }
  }

  const kindWord = artifactType === 'code' ? 'code file' : artifactType === 'html' ? 'HTML page' : 'document'
  const outputRule = outputRuleFor(artifactType, language)

  return {
    success: true,
    data: { artifactId, artifactType, title: cleanTitle },
    directive: { action: 'open_artifact', artifactId, artifactType, title: cleanTitle },
    // The synthesis pass IS the artifact body — the pipeline streams it into the
    // canvas pane, not the chat bubble (detected via the open_artifact directive).
    synthesisHint: `The user asked you to create a ${kindWord}${cleanTitle && cleanTitle !== 'Untitled' ? ` titled "${cleanTitle}"` : ''}. Write it now. ${outputRule}`,
  }
}

export const canvasTool: Tool = {
  id: 'canvas',
  name: 'Canvas',
  description:
    'Create a single self-contained, editable artifact in a side canvas — a code snippet/file, a written document (letter, essay, plan, checklist, notes), or a small HTML page. Use for standalone content the user will keep, edit, or reuse. NOT for multi-file apps/projects (that is the Coding tool).',
  examples: [
    'write me a cover letter for a marketing job',
    'draft a markdown checklist for moving apartments',
    'write a python function to parse a CSV file',
    'write a python program to scrape a website',
    'write a python script that reads an rss feed',
    'create a short essay about the water cycle',
    'make a simple HTML landing page with a signup button',
    'write a bash script to back up a folder',
    'write a program that does X',
    'draft a packing list for a beach trip',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'canvas',
      description:
        'Open an editable canvas artifact for a single self-contained piece of content the user wants to keep or edit (a code file/snippet, a written document, or a small HTML page). Do NOT use for multi-file projects or full applications.',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['code', 'document', 'html'],
            description: "'code' for a code file/snippet, 'document' for prose/markdown, 'html' for a small self-contained web page",
          },
          title: { type: 'string', description: 'A short title for the artifact (e.g. "Cover Letter", "CSV Parser")' },
          language: { type: 'string', description: "For code: the language (e.g. 'python', 'typescript', 'bash'). Omit for documents." },
        },
        required: ['type', 'title'],
      },
    },
  },
  offline: true,
  dataSources: [],
  execute,
}
