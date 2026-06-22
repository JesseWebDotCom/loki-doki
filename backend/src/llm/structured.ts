import { ollamaChat } from './ollama'
import type { OllamaChatMessage } from './ollama'

const JSON_SYSTEM = 'Respond ONLY with valid JSON in English. No explanation, no prose, no other language. Output must be parseable by JSON.parse().'

// Wrapper for any LLM call that must return structured JSON.
// Enforces English-only, strict JSON output, and retries once on parse failure.
export async function structuredCall<T>(
  model: string,
  userPrompt: string,
  systemPrompt?: string,
  options?: Record<string, unknown>,
): Promise<T> {
  const messages: OllamaChatMessage[] = [
    { role: 'system', content: systemPrompt ? `${JSON_SYSTEM}\n\n${systemPrompt}` : JSON_SYSTEM },
    { role: 'user', content: userPrompt },
  ]

  const attempt = async (msgs: OllamaChatMessage[]): Promise<T> => {
    const res = await ollamaChat(model, msgs, undefined, { ...options, temperature: 0.1 })
    const raw = res.message.content.trim()
    // Extract first JSON object or array from the response
    const match = raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/)
    if (!match) throw new Error(`No JSON found in response: ${raw.slice(0, 100)}`)
    return JSON.parse(match[0]) as T
  }

  try {
    return await attempt(messages)
  } catch {
    // Retry once with a more explicit correction prompt
    const retryMessages: OllamaChatMessage[] = [
      ...messages,
      { role: 'user', content: 'Your previous response was not valid JSON. Respond ONLY with valid JSON. Nothing else.' },
    ]
    return await attempt(retryMessages)
  }
}
