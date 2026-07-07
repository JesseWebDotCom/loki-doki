// Orchestrates the full podcast generation pipeline:
//   adapters → LLM script → TTS audio → MP3 file
// Called from downloadJobs.ts runJob() for 'podcast-generate' type.

import { db } from '@/db'
import { podcastShows, podcastEpisodes, podcastEpisodeSources, characters } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { userPath, resolveUserPath, toRelativePath } from '@/lib/storage/paths'
import type { DownloadProgress } from '@/lib/download'
import type { ShowConfig, PodcastGeneratePayload, ShowCast, EpisodeBeat, CastBrief, PodcastSourceType } from './types'
import { runAdapter } from './adapters/index'
import { generateScript } from './script'
import { generateEpisodeMeta } from './episodeMeta'
import { generateCast, advanceBeats, recordBeats } from './persona'
import { buildEpisodeAudio } from './audio'
import type { HostVoiceMap } from './audio'

export async function runPodcastGenerateJob(
  payload: PodcastGeneratePayload,
  onProgress: (p: DownloadProgress & { note?: string }) => void,
  signal: AbortSignal,
): Promise<void> {
  const { showId, episodeId, userId, userFirstName } = payload

  const emit = (note: string) => onProgress({ completed: 0, total: 100, speedBps: 0, etaSeconds: 0, note })

  // Mark as generating
  await db.update(podcastEpisodes)
    .set({ status: 'generating' })
    .where(eq(podcastEpisodes.id, episodeId))

  try {
    // Load show
    const [show] = await db.select().from(podcastShows).where(eq(podcastShows.id, showId))
    if (!show) throw new Error(`Show ${showId} not found`)

    const showConfig: ShowConfig = {
      id: show.id,
      name: show.name,
      description: show.description,
      style: show.style as ShowConfig['style'],
      hosts: JSON.parse(show.hostsJson) as ShowConfig['hosts'],
      segments: JSON.parse(show.segmentsJson) as ShowConfig['segments'],
      stinger: show.stingerJson ? JSON.parse(show.stingerJson) : undefined,
      ownerUserId: show.ownerUserId,
      targetMinutes: show.targetMinutes,
    }

    if (signal.aborted) throw new Error('Aborted')

    // Run content adapters. A per-episode override (e.g. specific YouTube videos)
    // takes precedence over the show's configured segments.
    emit('Collecting content…')
    const activeSegments = payload.segments?.length ? payload.segments : showConfig.segments
    const segmentContents = await Promise.all(
      activeSegments.map(seg => runAdapter(seg, userId, userFirstName))
    )

    // Load host character info
    const hostIds = showConfig.hosts.map(h => h.characterId)

    // Load all host characters
    const allHostRows = await Promise.all(
      hostIds.map(id =>
        db.select({ id: characters.id, name: characters.name, personalityPrompt: characters.personalityPrompt, ttsVoice: characters.ttsVoice, speechRate: characters.speechRate })
          .from(characters)
          .where(eq(characters.id, id))
          .then(rows => rows[0])
      )
    )

    const hostInfos = allHostRows
      .filter(Boolean)
      .map(h => ({
        id: h!.id,
        name: h!.name,
        personality: h!.personalityPrompt ?? 'Friendly and engaging podcast host.',
      }))

    if (hostInfos.length === 0) {
      hostInfos.push({ id: 'default', name: 'Host', personality: 'Friendly and engaging podcast host.' })
    }

    if (signal.aborted) throw new Error('Aborted')

    // ── Cast personas + this episode's evolving "life beats" (best-effort, internal) ──
    // Built once per show, then nudged forward each episode. A host can occasionally sit
    // an episode out (3+ host shows) — they're dropped from the script entirely.
    let cast: ShowCast | null = null
    let episodeBeats: EpisodeBeat[] = []
    try {
      cast = show.castJson ? JSON.parse(show.castJson) as ShowCast : null
      if (!cast?.members?.length) {
        cast = await generateCast(showConfig, hostInfos)
      } else if (cast.members.every(m => !m.voice)) {
        // One-time upgrade: casts built before on-air voices existed get personas
        // regenerated, keeping each host's accumulated beat history.
        const history = new Map(cast.members.map(m => [m.characterId, m.beatHistory ?? []]))
        cast = await generateCast(showConfig, hostInfos)
        for (const m of cast.members) m.beatHistory = history.get(m.characterId) ?? []
      }
      episodeBeats = await advanceBeats(cast, showConfig.style)
      recordBeats(cast, episodeBeats)
      await db.update(podcastShows).set({ castJson: JSON.stringify(cast) }).where(eq(podcastShows.id, showId))
    } catch { cast = null; episodeBeats = [] }

    const awayIds = new Set(episodeBeats.filter(b => b.away).map(b => b.characterId))
    // Never let absences empty the room — fall back to everyone if they would.
    const activeHosts = hostInfos.filter(h => !awayIds.has(h.id))
    const speakingHosts = activeHosts.length ? activeHosts : hostInfos

    const beatById = new Map(episodeBeats.map(b => [b.characterId, b]))
    const castBrief: CastBrief | undefined = cast ? {
      members: speakingHosts.map(h => {
        const m = cast!.members.find(x => x.characterId === h.id)
        // recordBeats already appended this episode's beat, so prior beats are everything
        // but the last entry — hand over the last two so the others can recall/tease.
        const recent = (m?.beatHistory ?? []).slice(0, -1).slice(-2)
        return { id: h.id, name: h.name, role: m?.role ?? '', background: m?.background ?? '', voice: m?.voice ?? '', hobbies: m?.hobbies ?? [], beat: beatById.get(h.id)?.beat ?? '', recent }
      }),
      away: episodeBeats.filter(b => b.away && !speakingHosts.some(h => h.id === b.characterId)).map(b => ({ name: b.name, beat: b.beat })),
    } : undefined

    if (signal.aborted) throw new Error('Aborted')

    // Generate script
    emit('Generating script with AI…')
    const scriptTurns = await generateScript(showConfig, segmentContents, speakingHosts, castBrief)

    // Write a catchy title + description ("show notes") from the finished script.
    // Best-effort — falls back to the date-based title and an empty description.
    emit('Writing episode notes…')
    const meta = await generateEpisodeMeta(showConfig.name, showConfig.style, scriptTurns, episodeBeats)

    // Build voice map
    const hostVoices: HostVoiceMap = {}
    for (const row of allHostRows.filter(Boolean)) {
      const rawVoice = row!.ttsVoice ?? 'kokoro:af_heart'
      // Strip engine prefix (e.g. "kokoro:af_heart" → "af_heart")
      const voice = rawVoice.includes(':') ? rawVoice.split(':')[1]! : rawVoice
      hostVoices[row!.id] = { voice, speed: row!.speechRate ?? 1.0 }
    }
    // Fallback for turns with unresolved host id
    hostVoices['default'] = { voice: 'af_heart', speed: 1.0 }

    if (signal.aborted) throw new Error('Aborted')

    // Build audio
    const outDir = await userPath(userId, userFirstName, 'podcasts')
    await mkdir(outDir, { recursive: true })

    const [episode] = await db.select({ title: podcastEpisodes.title }).from(podcastEpisodes).where(eq(podcastEpisodes.id, episodeId))
    // Prefer the AI headline; keep the date-based title as fallback. Used for both the
    // stored episode title and the MP3's embedded metadata.
    const episodeTitle = (meta?.title?.trim() || episode?.title || showConfig.name)

    // Resolve cover art if present
    let coverAbsPath: string | undefined
    if (show.coverRelPath) {
      try { coverAbsPath = await resolveUserPath(show.coverRelPath) } catch { /* optional */ }
    }

    // Resolve intro/outro stinger clips if the show has them.
    let stinger: { introAbsPath?: string; outroAbsPath?: string } | undefined
    if (showConfig.stinger?.introRelPath || showConfig.stinger?.outroRelPath) {
      stinger = {}
      if (showConfig.stinger.introRelPath) {
        try { stinger.introAbsPath = await resolveUserPath(showConfig.stinger.introRelPath) } catch { /* optional */ }
      }
      if (showConfig.stinger.outroRelPath) {
        try { stinger.outroAbsPath = await resolveUserPath(showConfig.stinger.outroRelPath) } catch { /* optional */ }
      }
    }

    emit('Synthesizing voices…')
    const { mp3AbsPath, durationSec, chapters } = await buildEpisodeAudio(
      scriptTurns,
      hostVoices,
      outDir,
      episodeId,
      { title: episodeTitle, showName: showConfig.name },
      coverAbsPath,
      stinger,
      note => emit(note),
      signal,
    )

    const relPath = await toRelativePath(mp3AbsPath)

    await db.update(podcastEpisodes).set({
      status: 'ready',
      title: episodeTitle,
      description: meta?.description?.trim() || null,
      audioRelPath: relPath,
      durationSec,
      chaptersJson: JSON.stringify(chapters),
      scriptJson: JSON.stringify(scriptTurns),
      generatedAt: new Date(),
    }).where(eq(podcastEpisodes.id, episodeId))

    // Record which source items (e.g. YouTube videos) fed this episode so the YouTube
    // watch page can show "featured in podcasts". Deduped across segments; best-effort.
    const sources = new Map<string, { id: string; title?: string; type: PodcastSourceType }>()
    for (const sc of segmentContents) {
      for (const s of sc.sources ?? []) {
        if (s.id && !sources.has(s.id)) sources.set(s.id, { id: s.id, title: s.title, type: s.type })
      }
    }
    if (sources.size > 0) {
      try {
        const now = new Date()
        await db.insert(podcastEpisodeSources).values(
          [...sources.values()].map(s => ({
            id: crypto.randomUUID(),
            episodeId,
            sourceType: s.type,
            sourceId: s.id,
            title: s.title ?? null,
            createdAt: now,
          })),
        ).onConflictDoNothing()
      } catch { /* non-fatal: episode is already saved */ }
    }

  } catch (err: any) {
    await db.update(podcastEpisodes).set({
      status: 'failed',
      error: String(err?.message ?? err),
    }).where(eq(podcastEpisodes.id, episodeId))
    throw err
  }
}
