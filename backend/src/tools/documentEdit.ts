import type { Tool, ToolResult } from './index'
import { eq, desc } from 'drizzle-orm'
import { db } from '@/db'
import { chatDocuments, chatDocumentEdits } from '@/db/schema'
import { ollamaChat } from '@/llm/ollama'
import { getModel } from '@/lib/models'

const EDIT_SYSTEM = `You are a precise document editor. You will receive a document and an instruction describing how to change it (e.g. fix spelling, fix grammar, summarize, rewrite, make more formal, shorten, translate, turn into bullet points).

Rules (strict):
1. Apply the instruction to the document and return the FULL resulting document text.
2. Return ONLY the edited document — no preamble, no commentary, no explanation, no surrounding quotes, and no markdown code fences.
3. Preserve the document's structure (paragraphs, headings, lists) unless the instruction asks you to change it.
4. If the instruction is to summarize or shorten, return only the summary/shortened version.
5. Keep the author's meaning and intent; only make the changes the instruction calls for.`.trim()

const EXPLAIN_SYSTEM = `You are a helpful assistant explaining a document to the user. You will receive a document (with its filename) and a request to explain, summarize, analyze, or answer a question about it.

Rules:
1. Answer the user's request clearly and accurately, grounded in the document's actual contents.
2. Open by naming the document — cite its filename (e.g. **plan.md**) in your first sentence.
3. Use well-structured markdown (short paragraphs, headings or bullet points where helpful).
4. Quote or reference specific parts of the document when it helps.
5. Do NOT rewrite or return the whole document — explain or answer instead.`.trim()

// Heuristic: is the user asking to understand the document (explain/analyze/Q&A)
// rather than transform it into a new version (fix/rewrite/translate/reformat)?
const EXPLAIN_RE = /\b(explain|describe|analy[sz]e|understand|interpret|clarify|break\s*down|go over|walk me through|tell me about|overview|what (?:is|are|does|do|was|were|happens?|happened)|who (?:is|are|was|were)|why|how (?:does|do|did|is|are)|meaning|gist|key (?:points|takeaways)|what'?s)\b/i

function isExplainIntent(instruction: string): boolean {
  return EXPLAIN_RE.test(instruction)
}

/** Pick the document this request is about: a filename mentioned in the request wins, else the most recent. */
function pickDocument(
  docs: { filename: string; text: string }[],
  instruction: string,
): { filename: string; text: string } | null {
  if (docs.length === 0) return null
  const lower = instruction.toLowerCase()
  const named = docs.find((d) => {
    const base = d.filename.toLowerCase().replace(/\.[^.]+$/, '')
    return base.length >= 3 && lower.includes(base)
  })
  return named ?? docs[0]!
}

/** report.docx → report-edited.txt ; notes.md → notes-edited.md */
function editedName(filename: string): string {
  const dot = filename.lastIndexOf('.')
  const base = dot > 0 ? filename.slice(0, dot) : filename
  const ext  = dot > 0 ? filename.slice(dot + 1).toLowerCase() : ''
  const keep = ext === 'md' || ext === 'markdown' || ext === 'txt'
  return `${base}-edited.${keep ? ext : 'txt'}`
}

export const documentEditTool: Tool = {
  id: 'document_edit',
  name: 'Document Assistant',
  description: 'Work with a document the user uploaded — edit it (fix spelling/grammar, summarize, rewrite, reformat, translate) or explain/analyze/answer questions about it',
  offline: true,
  dataSources: [],
  passMessage: 'instruction',

  examples: [
    'fix the spelling in my document',
    'fix the grammar in the document I uploaded',
    'proofread this document',
    'summarize this document',
    'rewrite this document to be more formal',
    'make my document more concise',
    'shorten this document',
    'turn this document into bullet points',
    'translate my document to Spanish',
    'clean up and polish this document',
    'edit the document I uploaded',
    'explain this document',
    'explain the document I uploaded',
    'what does this document say',
    'what is this document about',
    'analyze the attached file',
    'break down this document for me',
    'tell me about the document I attached',
    'what are the key points in this document',
  ],

  toolDefinition: {
    type: 'function',
    function: {
      name: 'document_edit',
      description: 'Work with a document the user has uploaded to this conversation. Use when the user asks to (a) edit/transform it — fix, proofread, summarize, shorten, rewrite, reformat, translate — or (b) explain, analyze, or answer questions about it. For edits, the full edited document is returned for the user to copy or download; for explanations, a clear answer is returned.',
      parameters: {
        type: 'object',
        required: ['instruction'],
        properties: {
          instruction: {
            type: 'string',
            description: 'What the user wants done with the document, in their own words (e.g. "fix the spelling", "summarize", "translate to Spanish", "explain this", "what are the key points").',
          },
        },
      },
    },
  },

  async execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const { instruction } = args as { instruction?: string }
    const convId = config?.['_conversationId'] as string | undefined
    const userId = config?.['_userId'] as string | undefined

    if (!instruction?.trim()) {
      return { success: false, error: 'No instruction provided' }
    }
    if (!convId || !userId) {
      return { success: false, error: 'Conversation context missing — cannot find the document' }
    }

    const docs = await db
      .select({ filename: chatDocuments.filename, text: chatDocuments.text })
      .from(chatDocuments)
      .where(eq(chatDocuments.conversationId, convId))
      .orderBy(desc(chatDocuments.createdAt))
      .limit(10)

    const doc = pickDocument(docs, instruction)
    if (!doc) {
      return {
        success: false,
        error: 'No document is attached to this conversation. Ask the user to upload a document first (the paperclip in the composer), then ask again.',
      }
    }

    const explain = isExplainIntent(instruction)

    // Size the context/output window to the document so a long file isn't truncated.
    const docTokens = Math.ceil(doc.text.length / 4)
    const num_ctx     = Math.min(16_384, Math.max(4_096, docTokens * 2 + 1_024))
    const num_predict = explain
      ? Math.min(4_096, Math.max(1_024, docTokens))
      : Math.min(8_192, Math.max(1_024, docTokens + 1_024))

    let out = ''
    try {
      const model = await getModel()
      const result = await ollamaChat(
        model,
        [
          { role: 'system', content: explain ? EXPLAIN_SYSTEM : EDIT_SYSTEM },
          { role: 'user', content: `${explain ? 'Request' : 'Instruction'}: ${instruction.trim()}\n\n--- DOCUMENT (${doc.filename}) ---\n${doc.text}` },
        ],
        [],
        { num_ctx, num_predict, temperature: explain ? 0.3 : 0.2 },
      )
      out = (result.message?.content ?? '').trim()
      if (!explain) {
        // Strip an accidental code fence if the model wrapped the edited output anyway.
        out = out.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim()
      }
    } catch {
      return { success: false, error: 'The document model failed to respond. Try again in a moment.' }
    }

    if (!out) {
      return { success: false, error: 'The model produced an empty result. Try rephrasing the request.' }
    }

    // Explain mode: the answer IS the reply — speak it directly, no download artifact.
    if (explain) {
      // Guarantee the filename is cited even if the model forgot to name it.
      const base = doc.filename.replace(/\.[^.]+$/, '').toLowerCase()
      const lower = out.toLowerCase()
      const namesDoc = lower.includes(doc.filename.toLowerCase()) || (base.length >= 3 && lower.includes(base))
      const body = namesDoc ? out : `**${doc.filename}**\n\n${out}`
      return {
        success: true,
        data: { mode: 'explain', filename: doc.filename },
        directReply: body,
      }
    }

    // Edit mode: persist the result so it stays downloadable later (the live result
    // card is ephemeral), then return a copyable/downloadable artifact block.
    const editedFilename = editedName(doc.filename)
    const editId = crypto.randomUUID()
    await db.insert(chatDocumentEdits).values({
      id: editId,
      conversationId: convId,
      userId,
      originalFilename: doc.filename,
      editedFilename,
      instruction: instruction.trim(),
      text: out,
      createdAt: new Date(),
    })
    const downloadUrl = `/api/chat/edited/${editId}/download`

    return {
      success: true,
      data: {
        mode: 'edit',
        editId,
        downloadUrl,
        filename: doc.filename,
        editedFilename,
        instruction: instruction.trim(),
        text: out,
      },
      // Snappy path: the artifact is in the block, so skip a second LLM pass that
      // would otherwise re-dump the whole document into the reply. The markdown link
      // is persisted with the message, so the edit stays downloadable after reload.
      directReply: `Done — I edited **${doc.filename}**. You can preview or copy the result below, or [download ${editedFilename}](${downloadUrl}).`,
    }
  },
}
