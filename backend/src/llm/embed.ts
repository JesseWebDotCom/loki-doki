import { ollamaEmbed } from './ollama'

export const EMBED_MODEL = 'nomic-embed-text'
// Dedicated router encoder — wider similarity spread than nomic, better separation
// between conversational and tool-intent messages for threshold-based routing.
export const ROUTER_EMBED_MODEL = 'all-minilm'

export async function embed(text: string): Promise<number[]> {
  return ollamaEmbed(EMBED_MODEL, text)
}

export async function embedForRouter(text: string): Promise<number[]> {
  return ollamaEmbed(ROUTER_EMBED_MODEL, text)
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let magA = 0
  let magB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    magA += a[i]! * a[i]!
    magB += b[i]! * b[i]!
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB)
  return denom === 0 ? 0 : dot / denom
}
