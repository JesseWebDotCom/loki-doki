import { basename } from 'node:path'
import { eq, and } from 'drizzle-orm'
import { db } from '@/db'
import { imageLoras, imageLoraUserCategoryGrants, imageLoraUserLoraGrants } from '@/db/schema'
import { ollamaChat } from '@/llm/ollama'
import { getProtections } from '@/lib/protections'
import { sanitizeTriggerTokens } from '@/lib/loraTokens'
import { resolveLoraFile } from '@/lib/loraFiles'

export interface SelectedLora {
  id: string
  filename: string      // basename of filePath without .safetensors
  weight: number
  triggerTokens: string[]
  isStylisticLora: boolean
}

function parseJson<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T } catch { return fallback }
}

export async function selectLoras(
  prompt: string,
  userId: string,
  isAdmin: boolean,
  model: string,
): Promise<SelectedLora[]> {
  if (!model || !prompt.trim()) return []

  const all = await db.select().from(imageLoras).where(eq(imageLoras.enabled, true))
  if (all.length === 0) return []

  // Access control
  let accessible = all
  if (!isAdmin) {
    const [loraGrants, categoryGrants, protections] = await Promise.all([
      db.select({ loraId: imageLoraUserLoraGrants.loraId })
        .from(imageLoraUserLoraGrants)
        .where(and(eq(imageLoraUserLoraGrants.userId, userId), eq(imageLoraUserLoraGrants.state, 'on'))),
      db.select({ categoryId: imageLoraUserCategoryGrants.categoryId })
        .from(imageLoraUserCategoryGrants)
        .where(and(eq(imageLoraUserCategoryGrants.userId, userId), eq(imageLoraUserCategoryGrants.state, 'on'))),
      getProtections(userId),
    ])

    if (loraGrants.length === 0 && categoryGrants.length === 0) return []

    const grantedLoraIds      = new Set(loraGrants.map(r => r.loraId))
    const grantedCategoryIds  = new Set(categoryGrants.map(r => r.categoryId))
    accessible = all.filter(l => {
      if (protections.blockAdultLoras && l.isAdult) return false
      return grantedLoraIds.has(l.id) ||
        (l.categoryId !== null && grantedCategoryIds.has(l.categoryId))
    })
  }

  // Only route against LoRAs with routing metadata and an accessible file
  // (resolveLoraFile self-heals a stale DB path before giving up on the file)
  const routable: typeof accessible = []
  for (const l of accessible) {
    if (!l.whenToUse) continue
    if (await resolveLoraFile(l)) routable.push(l)
  }
  if (routable.length === 0) return []

  // Build catalog summary
  const catalog = routable.map(l => {
    const examples = parseJson<string[]>(l.exampleRequests, [])
    const exStr = examples.length > 0 ? `, examples: [${examples.map(e => `"${e}"`).join(', ')}]` : ''
    return `- id: "${l.id}", when_to_use: "${l.whenToUse}"${exStr}`
  }).join('\n')

  const selectTool = {
    type: 'function' as const,
    function: {
      name: 'select_loras',
      description: 'Select LoRAs that clearly match the user prompt. Return only IDs of relevant LoRAs.',
      parameters: {
        type: 'object',
        required: ['selected_lora_ids'],
        properties: {
          selected_lora_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'IDs of matching LoRAs. Empty array if none clearly match.',
          },
        },
      },
    },
  }

  try {
    const resp = await ollamaChat(
      model,
      [
        {
          role: 'system',
          content: `You select LoRAs for an image generator. Given a user prompt, pick only the LoRAs that clearly apply. Return an empty array if none match.\n\nAvailable LoRAs:\n${catalog}`,
        },
        { role: 'user', content: prompt },
      ],
      [selectTool],
      { temperature: 0.0, num_predict: 128 },
    )

    const call = resp.message?.tool_calls?.[0]?.function
    if (!call || call.name !== 'select_loras') return []

    const ids = ((call.arguments as { selected_lora_ids?: unknown }).selected_lora_ids ?? []) as string[]
    return ids
      .map(id => routable.find(l => l.id === id))
      .filter((l): l is NonNullable<typeof l> => l !== undefined)
      .map(l => ({
        id: l.id,
        filename: basename(l.filePath, '.safetensors'),
        weight: l.defaultWeight,
        triggerTokens: sanitizeTriggerTokens(parseJson<string[]>(l.triggerTokens, [])),
        isStylisticLora: l.isStylisticLora ?? false,
      }))
  } catch {
    return []
  }
}
