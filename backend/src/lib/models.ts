import { db } from '@/db'
import { appSettings } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { ollamaChat, ollamaEmbed, ollamaList, ollamaWarmModel } from '@/llm/ollama'
import { EMBED_MODEL, ROUTER_EMBED_MODEL } from '@/llm/embed'
import { initRouter } from '@/llm/router'
import { logger } from '@/lib/logger'
import { CATALOG } from '@/lib/catalog'
import { getRemoteModelOverride } from '@/lib/remoteEngine'

async function getSetting(key: string): Promise<string | null> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1)
  return row ? (JSON.parse(row.value) as string) : null
}

export async function getModel(): Promise<string> {
  // A paired remote engine supplies its own model name (the local one may not exist there).
  const remote = getRemoteModelOverride()
  if (remote) return remote
  return (await getSetting('model')) ?? process.env.MODEL ?? 'llama3.1:8b'
}

// Long-form scriptwriting model (podcast episodes). The main chat model may be an
// abliterated/uncensored variant — great for unrestricted chat, but abliteration degrades
// instruction-following and coherence, which long scripted dialogue is very sensitive to.
// Admins can point scriptwriting at a stock instruct model in Admin → Podcasts; unset,
// it follows the main model.
export async function getScriptModel(): Promise<string> {
  const configured = (await getSetting('podcast.script_model'))?.trim()
  return configured || await getModel()
}

// AI book generation model (chapter prose + outline/story-bible). Same rationale as
// getScriptModel() — long-form creative writing wants a stock instruct model even when
// the main chat model is an abliterated/uncensored variant. Unset, follows the main model.
export async function getBookModel(): Promise<string> {
  const configured = (await getSetting('books.generate_model'))?.trim()
  return configured || await getModel()
}

// Cached router model — read once, re-read only on explicit invalidation.
// router_llm_model almost never changes (only via admin UI), so caching is safe.
let _routerModelCache: { value: string | null } | null = null

export async function getRouterModel(): Promise<string | null> {
  if (!_routerModelCache) {
    _routerModelCache = { value: (await getSetting('router_llm_model')) ?? process.env.ROUTER_MODEL ?? null }
  }
  return _routerModelCache.value
}

export function invalidateRouterModelCache(): void {
  _routerModelCache = null
}

// A small, fast model for short auxiliary text tasks (e.g. weather blurbs) where the
// big chat model is overkill — generating a one-line summary on a 12B model costs
// seconds of prefill + decode. Prefers the router LLM (already kept warm for routing,
// e.g. granite4.1:3b), falling back to the main chat model if that isn't installed.
let _fastModelCache: { value: string } | null = null

export async function getFastModel(): Promise<string> {
  if (_fastModelCache) return _fastModelCache.value
  const main = await getModel()
  const candidate =
    (await getSetting('router_llm_model')) ??
    process.env.ROUTER_MODEL ??
    CATALOG.find((m) => m.role === 'router_llm')?.ollamaTag ??
    null
  if (candidate && candidate !== main) {
    try {
      const installed = await ollamaList()
      if (installed.some((m) => m.name === candidate)) {
        _fastModelCache = { value: candidate }
        // Load the fast model into VRAM immediately so it's ready before the first
        // real call. Fire-and-forget — keep_alive: -1 keeps it there permanently.
        ollamaWarmModel(candidate).catch(() => {})
        return candidate
      }
    } catch {
      // Ollama unreachable — fall back to the main model.
    }
  }
  _fastModelCache = { value: main }
  return main
}

export function invalidateFastModelCache(): void {
  _fastModelCache = null
}

// Returns the best available vision-capable model:
// 1. Explicitly configured vision_model setting
// 2. The current chat model if it has builtinVision (e.g. Gemma 4 12B)
// 3. Fallback: gemma3:4b-it-qat (the catalog vision role default)
export async function getVisionModel(): Promise<string> {
  const explicit = await getSetting('vision_model')
  if (explicit) return explicit

  const chatModel = await getModel()
  const chatEntry = CATALOG.find(m => m.ollamaTag === chatModel || m.id === chatModel)
  if (chatEntry?.builtinVision) return chatModel

  return 'gemma3:4b-it-qat'
}

// Shared warmup promise — callers that need to wait for warmup to finish (e.g. the boot
// sequence) await this instead of firing their own duplicate Ollama requests.
let _warmupPromise: Promise<void> | null = null
export function getWarmupPromise(): Promise<void> | null { return _warmupPromise }

// Load both models into VRAM with keep_alive: -1 and init the semantic router.
// Runs at server startup so the first user message never pays cold-load tax.
//
// IMPORTANT: warmup must use the same system prompt PREFIX as real chat requests so
// llama.cpp's KV cache already contains those tokens when the first real turn arrives.
// Using a bare "hi" (no system message) means the cache never hits on turn 1 — every
// first message of every conversation pays full prefill cost (~2–5s for 12B models).
export function warmupModel(): Promise<void> {
  _warmupPromise = _doWarmup()
  return _warmupPromise
}

async function _doWarmup(): Promise<void> {
  const model = await getModel()

  // Pre-warm with the stable system prompt PREFIX that real chat turns share.
  // runCompanionTurn's prompt now begins with the content-policy block (see
  // buildContentPrompt), so warm with the DEFAULT profile's block — any user on the
  // default profile (with no character dial overrides) gets a KV-cache hit on that
  // whole prefix for their first turn. Memory/character sections vary per user and
  // can't be pre-warmed centrally. The old warmup primed a "Today is …" prefix the
  // real prompt no longer starts with, so turn 1 always paid full cold prefill.
  let warmupSystem = ''
  try {
    const { buildContentPrompt, getProfile, getDefaultProfileSlug } = await import('@/lib/contentPolicy')
    const profile = await getProfile(await getDefaultProfileSlug())
    if (profile) warmupSystem = buildContentPrompt(profile.dials)
  } catch { /* fall back to a bare warmup below */ }
  const warmupMessages = [
    ...(warmupSystem ? [{ role: 'system' as const, content: warmupSystem }] : []),
    { role: 'user' as const, content: 'hi' },
  ]

  const routerModel = await getRouterModel()

  // Warm the CHAT model FIRST and let THIS promise resolve as soon as it's resident.
  // The boot sequence awaits getWarmupPromise() to flip /api/system/ready, so gating
  // that on the chat model alone — not on every auxiliary model — lets a returning
  // user reach a usable app the moment they can chat. Loading the chat model on its
  // own also avoids the VRAM/PCIe contention of pulling 3-4 models into the GPU at
  // once (the old parallel warmup), which was a big chunk of the cold-start time.
  // num_ctx matches the chat default (8192) — a mismatched warmup context would
  // itself force a runner re-init on the first real turn.
  await ollamaChat(model, warmupMessages, [], {
    temperature: 0, num_predict: 1, num_ctx: 8192,
  })
    .then(() => logger.info(`[warmup] ${model} ready`))
    .catch(() => {})

  // Everything else (embeddings, router LLM, semantic-router index) warms in the
  // BACKGROUND — not awaited, so it never holds boot/ready. First use of any of these
  // still hits a warm model in the common case; worst case it cold-loads on first call.
  void (async () => {
    const [, routerEmbedOk] = await Promise.allSettled([
      ollamaEmbed(EMBED_MODEL, 'warmup')
        .then(() => logger.info(`[warmup] ${EMBED_MODEL} ready`))
        .catch(() => {}),
      ollamaEmbed(ROUTER_EMBED_MODEL, 'warmup')
        .then(() => { logger.info(`[warmup] ${ROUTER_EMBED_MODEL} ready`); return true })
        .catch(() => false),
      routerModel && routerModel !== model
        ? ollamaChat(routerModel, [{ role: 'user' as const, content: 'hi' }], [], {
            temperature: 0, num_predict: 1,
          })
            .then(() => logger.info(`[warmup] ${routerModel} (router) ready`))
            .catch(() => {})
        : Promise.resolve(),
    ])

    // Router indexing uses all-minilm — only init after it's warm
    if (routerEmbedOk.status === 'fulfilled' && routerEmbedOk.value) {
      initRouter().then(() => logger.info('[warmup] router indexed')).catch(() => {})
    } else {
      logger.info('[warmup] router skipped — all-minilm not available')
    }
  })()
}
