import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { serveStatic, createBunWebSocket } from 'hono/bun'
import { runMigrations, db } from '@/db'
import { logger } from '@/lib/logger'
import { startMemorySweep } from '@/memory/sweep'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { startBriefingRefresh } from '@/lib/briefing/refresh'
import { pruneExpiredSessions } from '@/lib/session'
import { warmupModel } from '@/lib/models'
import { requestLogger } from '@/middleware/requestLogger'
import { setup } from '@/routes/setup'
import { auth } from '@/routes/auth'
import { users } from '@/routes/users'
import { chat } from '@/routes/chat'
import { models } from '@/routes/models'
import { tts } from '@/routes/tts'
import { system } from '@/routes/system'
import { logs } from '@/routes/logs'
import { tools } from '@/routes/tools'
import { adminMemory } from '@/routes/adminMemory'
import { adminLatencyTest } from '@/routes/adminLatencyTest'
import { adminChatBenchmark } from '@/routes/adminChatBenchmark'
import { adminRouterBenchmark } from '@/routes/adminRouterBenchmark'
import { projects } from '@/routes/projects'
import { image } from '@/routes/image'
import { converter } from '@/routes/converter'
import { adminImageLoras } from '@/routes/adminImageLoras'
import { adminQueue } from '@/routes/adminQueue'
import { adminInstall } from '@/routes/adminInstall'
import { adminUninstall } from '@/routes/adminUninstall'
import { archives } from '@/routes/archives'
import { adminArchives } from '@/routes/adminArchives'
import { jobs as downloadJobsRoute } from '@/routes/jobs'
import { resumeDownloadJobs, scanAndRepairCorruptImageModels } from '@/lib/downloadJobs'
import { companions } from '@/routes/companions'
import { adminCompanions } from '@/routes/adminCompanions'
import { adminVoice } from '@/routes/adminVoice'
import { adminWakewords } from '@/routes/adminWakewords'
import { voice } from '@/routes/voice'
import { createSttRoute } from '@/routes/stt'
import { bookmarks } from '@/routes/bookmarks'
import { adminBookmarks } from '@/routes/adminBookmarks'
import { searchRouter } from '@/routes/search'
import { appFeatures } from '@/routes/appFeatures'
import { adminBriefing } from '@/routes/adminBriefing'
import { maps } from '@/routes/maps'
import { adminMaps } from '@/routes/adminMaps'
import { proxy } from '@/routes/proxy'
import { vision } from '@/routes/vision'
import { bored } from '@/routes/bored'
import { home } from '@/routes/home'
import { privacy } from '@/routes/privacy'
import { adminContent } from '@/routes/adminContent'
import { content } from '@/routes/content'
import { consent } from '@/routes/consent'
import { adminLocale } from '@/routes/adminLocale'
import { notificationsRoute } from '@/routes/notifications'
import { appStore } from '@/routes/appStore'
import { homeLayout } from '@/routes/homeLayout'
import { adminConnectivity } from '@/routes/adminConnectivity'
import { news } from '@/routes/news'
import { adminNews } from '@/routes/adminNews'
import { onThisDayRoute } from '@/routes/onThisDay'
import { sportsTodayRoute } from '@/routes/sportsToday'
import { sportsRoute } from '@/routes/sports'
import { jokeRoute } from '@/routes/joke'
import { jokesDedicatedRoute } from '@/routes/jokes'
import { tvShowsRoute } from '@/routes/tvShows'
import { showsRoute } from '@/routes/shows'
import { moviesRoute } from '@/routes/movies'
import { mediaRoute } from '@/routes/media'
import { imgRoute } from '@/routes/img'
import { libraryRoute } from '@/routes/library'
import { plexRoute } from '@/routes/plex'
import { adminHomeAssistant } from '@/routes/adminHomeAssistant'
import { homeAssistantRoute } from '@/routes/homeAssistant'
import { youtubeRoute } from '@/routes/youtube'
import { podcastsRoute } from '@/routes/podcasts'
import { music } from '@/routes/music'
import { musicInfo } from '@/routes/musicInfo'
import { musicRadio } from '@/routes/musicRadio'
import { musicCatalog } from '@/routes/musicCatalog'
import { musicStations } from '@/routes/musicStations'
import { musicPlaylists } from '@/routes/musicPlaylists'
import { musicLibrary } from '@/routes/musicLibrary'
import { logoRoute } from '@/routes/logo'
import adminStorage from '@/routes/adminStorage'
import { startYoutubeFeedPoller, backfillAllThumbnails } from '@/lib/youtube/feed'
import { feeds as feedsRoute } from '@/routes/feeds'
import { seedSystemFeeds } from '@/lib/feeds/seed'
import { startFeedPoller, refreshSystemFeeds } from '@/lib/feeds/poller'
import { startYoutubeReconcile } from '@/lib/youtube/reconcile'
import { backfillYoutubeTitleEntities } from '@/lib/youtube/titleBackfill'
import { startImageCacheMaintenance } from '@/lib/youtube/imageCache'
import { mediaImageCacheSweep } from '@/lib/titles/imageProxy'
import { imageCacheSweep } from '@/lib/imageProxy'
import { startYtdlpAutoUpdate } from '@/lib/youtube/ytdlp'
import { whereToWatchRoute } from '@/routes/whereToWatch'
import { dictionaryRoute } from '@/routes/dictionary'
import { recipesRoute } from '@/routes/recipes'
import { showtimesRoute } from '@/routes/showtimes'
import { skillsRoute, adminSkillsRoute } from '@/routes/skills'
import { voiceMemosRoute } from '@/routes/voiceMemos'
import { adminRemoteEngineRoute } from '@/routes/adminRemoteEngine'
import { loadRemoteEngine } from '@/lib/remoteEngine'
import { medicalRoute } from '@/routes/medical'
import { holidaysRoute } from '@/routes/holidays'
import { localEventsRoute } from '@/routes/localEvents'
import { time } from '@/routes/time'
import { lookup } from '@/routes/lookup'
import { startHomeAssistantSync } from '@/lib/homeAssistant'
import { seedContentProfiles } from '@/lib/contentPolicy'
import { frigate } from '@/routes/frigate'
import { adminFrigate } from '@/routes/adminFrigate'
import { startFrigateMqtt } from '@/lib/frigate/mqtt'
import { maybeSpawnComfyUI, stopComfyUI } from '@/lib/comfyui'
import { maybeSpawnSearXNG, maybeUpdateSearXNG, stopSearXNG } from '@/lib/searxng'
import { maybeSpawnKiwix, stopKiwix } from '@/lib/kiwix'
import { maybeSpawnVoiceServer, stopVoiceServer } from '@/lib/voiceServer'
import { reconcileBuiltinPronunciationPacks } from '@/lib/voice/pronunciation'
import { startPodGateway } from '@/lib/pod/gateway'
import { startPodScheduler } from '@/lib/pod/scheduler'
import { pod } from '@/routes/pod'
import { maybeBuildWorldGeoJSON, maybeBuildWorldOverview } from '@/lib/maps/toolchain'
import { stopGraphHopper } from '@/lib/maps/graphhopper'
import { listHealthyArchivePaths } from '@/lib/archives'

runMigrations()
// Seed the remote-engine override cache so ollamaUrl() resolves correctly from boot.
void loadRemoteEngine()
// One-time grandfather: installs that finished setup BEFORE the offline-content welcome
// wizard existed already chose their library/maps in the old flow, so mark it seen for
// them. Brand-new installs boot here before setup completes (first_run_complete=false),
// so the flag stays unset and the wizard shows once after their first real boot.
void (async () => {
  if ((await getAppSetting('welcome_flag_migrated')) === true) return
  if ((await getAppSetting('first_run_complete')) === true) await setAppSetting('welcome_complete', true)
  await setAppSetting('welcome_flag_migrated', true)
})()
startMemorySweep()
startBriefingRefresh()
// Prune expired session rows at boot and hourly so the sessions table doesn't grow
// unbounded. Expired tokens are already rejected on use; this just reclaims the rows.
void pruneExpiredSessions().catch(() => {})
setInterval(() => { void pruneExpiredSessions().catch(() => {}) }, 60 * 60 * 1000)
// Warm the model into VRAM at startup — but only once setup has picked one. On a fresh
// install no model is selected yet, so a warmup would fire a doomed request at an Ollama
// that may not even be running. setup.ts calls warmupModel() itself once the user chooses.
void (async () => { if ((await getAppSetting('first_run_complete')) === true) warmupModel() })()
void startHomeAssistantSync()
// Seed built-in content profiles + backfill user assignments (idempotent).
void seedContentProfiles().catch((e) => logger.warn(`[content] profile seed failed: ${e}`))
// Seed built-in pronunciation packs so TTS rules apply from first boot, not only
// after an admin visits the packs tab.
void reconcileBuiltinPronunciationPacks().catch((e) => logger.warn(`[voice] pronunciation pack seed failed: ${e}`))
// Seed the app default voice once so the admin UI shows a real voice instead of
// "Not set". The resolver already falls back to kokoro:af_heart at runtime, but
// persisting it makes the default explicit and editable. Idempotent.
void (async () => {
  if (!(await getAppSetting('voice.app_default_voice'))) {
    await setAppSetting('voice.app_default_voice', 'kokoro:af_heart')
  }
})().catch((e) => logger.warn(`[voice] default-voice seed failed: ${e}`))
// Connect to the (remote) Frigate broker if configured — drives camera event
// notifications + companion announcements. No-op until an admin sets it up.
void startFrigateMqtt()
// Scan image model .safetensors files for corruption before spawning ComfyUI — a
// corrupt checkpoint causes an inscrutable generation error rather than a clear
// install failure. Deletes bad files and re-queues them so the repair is automatic.
scanAndRepairCorruptImageModels()
  .then(repaired => {
    if (repaired.length) logger.warn(`[image] quarantined ${repaired.length} corrupt model file(s) at boot: ${repaired.join(', ')}`)
    maybeSpawnComfyUI()
  })
  .catch(() => { maybeSpawnComfyUI() })
maybeSpawnVoiceServer()
// Web-search metasearch sidecar: start fast with the current checkout, then (when a
// weekly check is due) pull the latest SearXNG so its engine adapters stay current —
// a stale checkout silently rots as upstream sites change. Both calls no-op if it
// isn't installed. The update self-gates on a persisted timestamp + restarts only when
// the checkout actually moved; a daily timer catches long-running instances.
maybeSpawnSearXNG()
void maybeUpdateSearXNG()
setInterval(() => void maybeUpdateSearXNG(), 24 * 60 * 60 * 1000)
// Pod gateway: a Wyoming-protocol TCP listener that ESP32 satellites (and the
// scripts/pod-test-satellite.ts harness) connect to. Reuses STT/TTS/LLM brains.
// See plans/hardware-devices/pod-wyoming-architecture.md. Disable: POD_GATEWAY_ENABLED=0.
startPodGateway()
// Server-side scheduler: fires alarms/timers to a user's connected Pods over the
// persistent gateway socket (additive to the browser Time app's own firing).
startPodScheduler()
// Build the zoomed-out world basemap in the background if the maps toolchain is
// installed but the overview hasn't been built yet (one-time, then cached).
void maybeBuildWorldOverview()
// Generate the country/state/label GeoJSON overlays if missing (e.g. upgraded
// from a version that predates this step, or the PMTiles built without them).
void maybeBuildWorldGeoJSON()

// Spawn kiwix-serve for installed ZIM archives — but quarantine any corrupt ones FIRST
// (a single bad ZIM crashes the whole server natively), so we only ever start with files
// known to open. Bad ones are deleted + re-queued for download.
listHealthyArchivePaths()
  .then(({ valid, quarantined }) => {
    if (quarantined.length) logger.warn(`[archives] quarantined ${quarantined.length} corrupt archive(s) at boot: ${quarantined.join(', ')}`)
    if (valid.length > 0) maybeSpawnKiwix(valid)
  })
  .catch(() => {})

// Resume any background download jobs left pending/running from a prior session,
// and start the scheduler that drains the queue (≤1 large, ≤1 per host, ≤4 total).
void resumeDownloadJobs()
startYoutubeFeedPoller()
// Feeds: seed curated News as system feeds, kick an initial fetch, then poll on an interval.
void seedSystemFeeds().then(() => refreshSystemFeeds()).catch(() => {})
startFeedPoller()
// Slow back-catalog sweep: RSS only shows the 15 newest items, so anything that scrolls past
// that window between polls (bursts / extended downtime) is invisible to the poller forever.
// This re-scans each subscription deeply ~weekly to backfill those missed rows. See reconcile.ts.
startYoutubeReconcile()
void backfillAllThumbnails().catch(() => {})
// One-time: decode HTML entities in titles stored before ingestion-side decoding.
void backfillYoutubeTitleEntities().catch(() => {})
// Disk cache for YouTube artwork: evict non-subscribed images 24h after fetch, and
// conditionally re-validate subscribed channel art every 24h. Runs ~30s after boot too.
startImageCacheMaintenance()
// Bound the Shows/Movies media-image disk cache: sweep oldest art when over the ceiling.
setTimeout(() => void mediaImageCacheSweep(), 60_000)
setInterval(() => void mediaImageCacheSweep(), 24 * 60 * 60 * 1000)
// Bound the app-wide /api/img proxy cache (news/article/misc remote images).
setTimeout(() => void imageCacheSweep(), 90_000)
setInterval(() => void imageCacheSweep(), 24 * 60 * 60 * 1000)
// Keep yt-dlp fresh (it breaks against YouTube changes when stale): resolve/provision
// the binary now, update it if due, then refresh weekly. Best-effort, non-blocking.
startYtdlpAutoUpdate()

// Bookmarks capture engine: resolve (and if needed download) a headless Chromium ahead of the
// first archive so the initial save isn't stalled by a ~150MB install. Best-effort.
import('@/lib/bookmarks/render').then((m) => m.ensureChromium()).catch(() => {})
// Bookmarks auto-update: periodically re-archive items the user marked for monitoring, and alert
// on content changes. Rides the download queue, so it's bounded the same way archiving is.
import('@/lib/bookmarks/autoUpdate').then((m) => m.startBookmarkAutoUpdatePoller()).catch(() => {})

// Unload Ollama models on shutdown so they don't linger in VRAM between sessions.
async function unloadOllamaModels() {
  const base = (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '')
  try {
    const res = await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(3_000) })
    const { models } = await res.json() as { models: { name: string }[] }
    await Promise.allSettled(
      models.map(m =>
        fetch(`${base}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: m.name, keep_alive: 0 }),
          signal: AbortSignal.timeout(5_000),
        })
      )
    )
    logger.info('[shutdown] Ollama models unloaded')
  } catch { /* best-effort */ }
}

// Kill the spawned sidecars on shutdown so they don't outlive the backend and hold
// their ports (which would make the next boot's spawn fail with "port in use"). Each
// is wrapped so one failing doesn't block the rest.
async function stopSidecars() {
  try { await stopKiwix() } catch { /* best-effort */ }
  try { stopComfyUI() } catch { /* best-effort */ }
  try { stopSearXNG() } catch { /* best-effort */ }
  try { stopVoiceServer() } catch { /* best-effort */ }
  try { stopGraphHopper() } catch { /* best-effort */ }
}

async function shutdown() {
  await Promise.allSettled([unloadOllamaModels(), stopSidecars()])
  process.exit(0)
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())

const app = new Hono()

// Bun WebSocket adapter — `websocket` MUST be on the default export below or
// `server.upgrade` silently fails and the STT socket never connects.
const { upgradeWebSocket, websocket } = createBunWebSocket()

if (process.env.NODE_ENV === 'development') {
  app.use('*', cors({ origin: 'http://localhost:5173', credentials: true }))
}

app.use('*', requestLogger)

// Global error boundary: without this, any throw from a route handler surfaces as a
// bare, body-less 500 that's indistinguishable from a transient stall — so a real bug
// looks identical to a hot-reload blip. Log the route + message (so it's diagnosable)
// and return structured JSON. HTTPExceptions carry their own intended status/response.
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse()
  const msg = err instanceof Error ? err.message : String(err)
  logger.error({ err, method: c.req.method, path: c.req.path }, `unhandled error: ${c.req.method} ${c.req.path} — ${msg}`)
  return c.json({ error: 'Internal Server Error' }, 500)
})

// Cheap, unauthenticated liveness probe so the frontend can tell "backend is down"
// apart from "request failed" and surface/recover instead of hanging silently.
app.get('/api/health', (c) => c.json({ ok: true }))

app.route('/api/setup', setup)
app.route('/api/auth', auth)
app.route('/api/users', users)
app.route('/api/chat', chat)
app.route('/api/models', models)
app.route('/api/tts', tts)
app.route('/api/system', system)
app.route('/api/logs', logs)
app.route('/api/tools', tools)
app.route('/api/admin/memory', adminMemory)
app.route('/api/admin/latency-test', adminLatencyTest)
app.route('/api/admin/chat-benchmark', adminChatBenchmark)
app.route('/api/admin/router-benchmark', adminRouterBenchmark)
app.route('/api/projects', projects)
app.route('/api/image', image)
app.route('/api/converter', converter)
app.route('/api/admin/image-loras', adminImageLoras)
app.route('/api/admin/queue', adminQueue)
app.route('/api/admin/install', adminInstall)
app.route('/api/admin/uninstall', adminUninstall)
app.route('/api/archives', archives)
app.route('/api/admin/archives', adminArchives)
app.route('/api/jobs', downloadJobsRoute)
app.route('/api/companions', companions)
app.route('/api/admin/companions', adminCompanions)
app.route('/api/admin/voice', adminVoice)
app.route('/api/admin/wakewords', adminWakewords)
app.route('/api/voice', voice)
app.route('/api/stt', createSttRoute(upgradeWebSocket))
app.route('/api/pod', pod)
app.route('/api/bookmarks', bookmarks)
app.route('/api/admin/bookmarks', adminBookmarks)
// Deprecated alias: archives captured before the Reader→Bookmarks rename baked
// `/api/reader/<id>/archive/*` asset URLs into their saved HTML. Keep serving them.
app.route('/api/reader', bookmarks)
app.route('/api/search', searchRouter)
app.route('/api/app-features', appFeatures)
app.route('/api/admin/briefing', adminBriefing)
app.route('/api/maps', maps)
app.route('/api/admin/maps', adminMaps)
app.route('/api/proxy', proxy)
app.route('/api/vision', vision)
app.route('/api/bored', bored)
app.route('/api/home', home)
app.route('/api/privacy', privacy)
app.route('/api/admin/content', adminContent)
app.route('/api/content', content)
app.route('/api/consent', consent)
app.route('/api/admin/locale', adminLocale)
app.route('/api/notifications', notificationsRoute)
app.route('/api/app-store', appStore)
app.route('/api/home-layout', homeLayout)
app.route('/api/admin/connectivity', adminConnectivity)
app.route('/api/news', news)
app.route('/api/admin/news', adminNews)
app.route('/api/feeds', feedsRoute)
app.route('/api/on-this-day', onThisDayRoute)
app.route('/api/sports/today', sportsTodayRoute)
app.route('/api/sports', sportsRoute)
app.route('/api/joke', jokeRoute)
app.route('/api/jokes', jokesDedicatedRoute)
app.route('/api/tv-shows', tvShowsRoute)
app.route('/api/shows', showsRoute)
app.route('/api/movies', moviesRoute)
app.route('/api/media', mediaRoute)
app.route('/api/img', imgRoute)
app.route('/api/library', libraryRoute)
app.route('/api/plex', plexRoute)
app.route('/api/admin/home-assistant', adminHomeAssistant)
app.route('/api/home-assistant', homeAssistantRoute)
app.route('/api/frigate', frigate)
app.route('/api/admin/frigate', adminFrigate)
app.route('/api/youtube', youtubeRoute)
app.route('/api/podcasts', podcastsRoute)
app.route('/api/music', music)
app.route('/api/music/info', musicInfo)
app.route('/api/music/radio', musicRadio)
app.route('/api/music/catalog', musicCatalog)
app.route('/api/music/stations', musicStations)
app.route('/api/music/playlists', musicPlaylists)
app.route('/api/music/library', musicLibrary)
app.route('/api/logo', logoRoute)
app.route('/api/where-to-watch', whereToWatchRoute)
app.route('/api/dictionary', dictionaryRoute)
app.route('/api/recipes', recipesRoute)
app.route('/api/showtimes', showtimesRoute)
app.route('/api/skills', skillsRoute)
app.route('/api/admin/users', adminSkillsRoute)
app.route('/api/voice/memos', voiceMemosRoute)
app.route('/api/admin/remote-engine', adminRemoteEngineRoute)
app.route('/api/medical', medicalRoute)
app.route('/api/holidays', holidaysRoute)
app.route('/api/local-events', localEventsRoute)
app.route('/api/time', time)
app.route('/api/lookup', lookup)
app.route('/api/admin/storage', adminStorage)

// Docs site — served at /docs/* in both dev and prod (static, no auth required)
app.use('/docs/*', serveStatic({ root: '../docs/dist', rewriteRequestPath: (p) => p.replace(/^\/docs/, '') || '/' }))

if (process.env.NODE_ENV !== 'development') {
  app.use('*', serveStatic({ root: '../frontend/dist' }))
  app.get('*', serveStatic({ path: '../frontend/dist/index.html' }))
}

const port = parseInt(process.env.PORT ?? '3000')
logger.info(`loki-doki running on http://localhost:${port}`)

export default { port, fetch: app.fetch, websocket, idleTimeout: 0 }
