// Narration session orchestration: text → detected speakers → assigned voices →
// persisted session/speakers/turns. Both the REST route (routes/narration.ts) and
// the companion tool (tools/narrate.ts) call buildSessionFromText() so detection
// logic never gets duplicated between the two entry points.

import { randomUUID } from 'node:crypto'
import { eq, asc } from 'drizzle-orm'
import { db } from '@/db'
import { narrationSessions, narrationSpeakers, narrationTurns } from '@/db/schema'
import { detectTurns, normalizeSpeakers } from './detect'
import { assignVoices } from './voicePool'

export interface NarrationSessionView {
  id: string
  title: string
  status: string
  detectionMethod: string | null
  error: string | null
  speakers: { id: string; label: string; voiceId: string; speechRate: number; isNarrator: boolean }[]
  turns: { speakerId: string; text: string }[]
}

const MAX_SESSION_CHARS = 60_000

export async function buildSessionFromText(opts: {
  userId: string
  text: string
  title?: string
  sourceType?: 'paste' | 'upload' | 'bookmark' | 'chat_document'
  sourceRef?: string
}): Promise<NarrationSessionView> {
  const text = opts.text.trim().slice(0, MAX_SESSION_CHARS)
  const sessionId = randomUUID()
  const now = new Date()

  if (!text) {
    await db.insert(narrationSessions).values({
      id: sessionId,
      userId: opts.userId,
      title: opts.title ?? '',
      sourceType: opts.sourceType ?? 'paste',
      sourceRef: opts.sourceRef ?? null,
      text: '',
      status: 'failed',
      error: 'No text to narrate',
      createdAt: now,
      updatedAt: now,
    })
    return getSession(sessionId) as Promise<NarrationSessionView>
  }

  await db.insert(narrationSessions).values({
    id: sessionId,
    userId: opts.userId,
    title: opts.title ?? text.slice(0, 60),
    sourceType: opts.sourceType ?? 'paste',
    sourceRef: opts.sourceRef ?? null,
    text,
    status: 'detecting',
    createdAt: now,
    updatedAt: now,
  })

  try {
    const detection = await detectTurns(text)
    const { speakers, turns } = normalizeSpeakers(detection.turns)
    const voiceByKey = assignVoices(speakers)

    const speakerIdByKey = new Map<string, string>()
    for (const [idx, s] of speakers.entries()) {
      const id = randomUUID()
      speakerIdByKey.set(s.normalizedKey, id)
      await db.insert(narrationSpeakers).values({
        id,
        sessionId,
        label: s.label,
        normalizedKey: s.normalizedKey,
        voiceId: voiceByKey.get(s.normalizedKey)!,
        speechRate: 1.0,
        orderIndex: idx,
        isNarrator: s.isNarrator,
      })
    }

    for (const [idx, t] of turns.entries()) {
      await db.insert(narrationTurns).values({
        id: randomUUID(),
        sessionId,
        speakerId: speakerIdByKey.get(t.normalizedKey)!,
        turnIndex: idx,
        text: t.text,
      })
    }

    await db.update(narrationSessions)
      .set({ status: 'ready', detectionMethod: detection.method, updatedAt: new Date() })
      .where(eq(narrationSessions.id, sessionId))
  } catch (err) {
    await db.update(narrationSessions)
      .set({ status: 'failed', error: String(err), updatedAt: new Date() })
      .where(eq(narrationSessions.id, sessionId))
  }

  return getSession(sessionId) as Promise<NarrationSessionView>
}

export async function getSession(sessionId: string): Promise<NarrationSessionView | null> {
  const [session] = await db.select().from(narrationSessions).where(eq(narrationSessions.id, sessionId)).limit(1)
  if (!session) return null

  const speakers = await db.select().from(narrationSpeakers)
    .where(eq(narrationSpeakers.sessionId, sessionId))
    .orderBy(asc(narrationSpeakers.orderIndex))
  const turns = await db.select().from(narrationTurns)
    .where(eq(narrationTurns.sessionId, sessionId))
    .orderBy(asc(narrationTurns.turnIndex))

  return {
    id: session.id,
    title: session.title,
    status: session.status,
    detectionMethod: session.detectionMethod,
    error: session.error,
    speakers: speakers.map(s => ({
      id: s.id, label: s.label, voiceId: s.voiceId, speechRate: s.speechRate, isNarrator: s.isNarrator,
    })),
    turns: turns.map(t => ({ speakerId: t.speakerId, text: t.text })),
  }
}

export async function updateSpeakerVoice(
  sessionId: string,
  speakerId: string,
  updates: { voiceId?: string; speechRate?: number },
): Promise<void> {
  const [speaker] = await db.select().from(narrationSpeakers)
    .where(eq(narrationSpeakers.id, speakerId)).limit(1)
  if (!speaker || speaker.sessionId !== sessionId) throw new Error('Speaker not found in this session')

  await db.update(narrationSpeakers)
    .set({
      voiceId: updates.voiceId ?? speaker.voiceId,
      speechRate: updates.speechRate ?? speaker.speechRate,
    })
    .where(eq(narrationSpeakers.id, speakerId))
}

export async function deleteSession(sessionId: string): Promise<void> {
  await db.delete(narrationSessions).where(eq(narrationSessions.id, sessionId))
}
