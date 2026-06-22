import { db } from '@/db'
import { memories } from '@/db/schema'
import { embed } from '@/llm/embed'

export function friendshipLine(firstMet: Date | null): string | null {
  if (!firstMet) return 'This is your very first conversation together.'
  const days = Math.floor((Date.now() - firstMet.getTime()) / 86_400_000)
  if (days === 0) return 'You just met today.'
  if (days === 1) return 'You met yesterday.'
  if (days < 14) return `You've known each other for ${days} days.`
  if (days < 60) return `You've known each other for ${Math.floor(days / 7)} week${Math.floor(days / 7) === 1 ? '' : 's'}.`
  if (days < 365) return `You've known each other for ${Math.floor(days / 30)} month${Math.floor(days / 30) === 1 ? '' : 's'}.`
  const years = Math.floor(days / 365)
  return `You've known each other for ${years} year${years === 1 ? '' : 's'}.`
}

// Writes a durable relationship memory on first meeting so the character
// can naturally recall when they first met without it being re-injected
// into every prompt. Fire-and-forget — caller should not await.
export async function writeFirstMetMemory(
  userId: string,
  characterId: string,
  characterName: string,
  userDisplayName: string,
  firstMet: Date,
): Promise<void> {
  const dateStr = firstMet.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  const text = `I first met ${userDisplayName} on ${dateStr}. That was the start of our friendship.`
  const embedding = await embed(text).catch(() => null)
  await db.insert(memories).values({
    id: crypto.randomUUID(),
    userId,
    characterId,
    text,
    sourceText: `First interaction between ${characterName} and ${userDisplayName}`,
    category: 'relationship',
    tier: 'durable',
    importance: 9,
    pinned: false,
    uses: 0,
    embedding: embedding ? JSON.stringify(embedding) : null,
    createdAt: firstMet,
    updatedAt: firstMet,
  }).onConflictDoNothing().catch(() => {})
}
