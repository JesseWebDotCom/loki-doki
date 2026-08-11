// Keep this first: locks PLAYWRIGHT_BROWSERS_PATH before anything can load playwright.
import '@/lib/playwrightEnv'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { serveStatic, createBunWebSocket } from 'hono/bun'
import { runMigrations, db } from '@/db'
import { logger } from '@/lib/logger'
import { startMemorySweep } from '@/memory/sweep'
import { startCompanionCheckins } from '@/lib/companionProactive'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { startBriefingRefresh } from '@/lib/briefing/refresh'
import { pruneExpiredSessions } from '@/lib/session'
import { warmupModel } from '@/lib/models'
import { requestLogger } from '@/middleware/requestLogger'
import { gzipJson } from '@/middleware/compress'
import { recordApiLatency } from '@/lib/apiLatency'
import { setup } from '@/routes/setup'
import { auth } from '@/routes/auth'
import { users } from '@/routes/users'
import { chat } from '@/routes/chat'
import { models } from '@/routes/models'
import { tts } from '@/routes/tts'
import { system, startBootSequence } from '@/routes/system'
import { logs } from '@/routes/logs'
import { tools } from '@/routes/tools'
import { adminMemory } from '@/routes/adminMemory'
import { memory } from '@/routes/memory'
import { adminLatencyTest } from '@/routes/adminLatencyTest'
import { adminChatBenchmark } from '@/routes/adminChatBenchmark'
import { adminRouterBenchmark } from '@/routes/adminRouterBenchmark'
import { projects } from '@/routes/projects'
import { image } from '@/routes/image'
import { converter } from '@/routes/converter'
import { drop } from '@/routes/drop'
import { desktopApp } from '@/routes/desktop'
import { startDropSweep } from '@/lib/drop/service'
import { startMediaAlertsSweep } from '@/lib/media/alerts'
import { startStationCoverBackfill } from '@/lib/music/coverBackfill'
import { adminImageLoras } from '@/routes/adminImageLoras'
import { adminQueue } from '@/routes/adminQueue'
import { adminGpu } from '@/routes/adminGpu'
import { adminMedia } from '@/routes/adminMedia'
import { adminInstall } from '@/routes/adminInstall'
import { adminModelSets } from '@/routes/adminModelSets'
import { adminUninstall } from '@/routes/adminUninstall'
import { adminServer } from '@/routes/adminServer'
import { registerSidecarStopper } from '@/lib/gracefulExit'
import { archives } from '@/routes/archives'
import { adminArchives } from '@/routes/adminArchives'
import { jobs as downloadJobsRoute } from '@/routes/jobs'
import { resumeDownloadJobs, scanAndRepairCorruptImageModels } from '@/lib/downloadJobs'
import { dataDir } from '@/lib/download'
import { companions } from '@/routes/companions'
import { adminCompanions } from '@/routes/adminCompanions'
import { adminVoice } from '@/routes/adminVoice'
import { adminWakewords } from '@/routes/adminWakewords'
import { voice } from '@/routes/voice'
import { createSttRoute } from '@/routes/stt'
import { bookmarks } from '@/routes/bookmarks'
import { adminBookmarks } from '@/routes/adminBookmarks'
import { notesRouter } from '@/routes/notes'
import { narration } from '@/routes/narration'
import { writingToolsRoute } from '@/routes/writingTools'
import { translateRoute } from '@/routes/translate'
import { books } from '@/routes/books'
import { booksGenerate } from '@/routes/booksGenerate'
import { adminBooks } from '@/routes/adminBooks'
import { kosync } from '@/routes/kosync'
import { opds } from '@/routes/opds'
import { searchRouter } from '@/routes/search'
import { webSearchRouter } from '@/routes/webSearch'
import { appFeatures } from '@/routes/appFeatures'
import { requireFeature, isFeatureEnabled } from '@/lib/featureGate'
import { adminBriefing } from '@/routes/adminBriefing'
import { briefing } from '@/routes/briefing'
import { push } from '@/routes/push'
import { notifyChannels } from '@/routes/notifyChannels'
import { adminNotify } from '@/routes/adminNotify'
import { maps } from '@/routes/maps'
import { adminMaps } from '@/routes/adminMaps'
import { proxy } from '@/routes/proxy'
import { vision } from '@/routes/vision'
import { bored } from '@/routes/bored'
import { home } from '@/routes/home'
import { privacy } from '@/routes/privacy'
import { adminContent } from '@/routes/adminContent'
import { content } from '@/routes/content'
import { familyAudio } from '@/routes/familyAudio'
import { adminFamilyAudio } from '@/routes/adminFamilyAudio'
import { startFamilyAudioDigestPoller } from '@/lib/family/digest'
import { consent } from '@/routes/consent'
import { adminLocale } from '@/routes/adminLocale'
import { adminSpeedtest } from '@/routes/adminSpeedtest'
import { notificationsRoute } from '@/routes/notifications'
import { appStore } from '@/routes/appStore'
import { homeLayout } from '@/routes/homeLayout'
import { mediaProgress } from '@/routes/mediaProgress'
import { adminConnectivity } from '@/routes/adminConnectivity'
import { news } from '@/routes/news'
import { adminNews } from '@/routes/adminNews'
import { onThisDayRoute } from '@/routes/onThisDay'
import { sportsTodayRoute } from '@/routes/sportsToday'
import { sportsRoute } from '@/routes/sports'
import { jokesDedicatedRoute } from '@/routes/jokes'
import { tvShowsRoute } from '@/routes/tvShows'
import { showsRoute } from '@/routes/shows'
import { moviesRoute } from '@/routes/movies'
import { mediaRoute } from '@/routes/media'
import { mediaIntegrationsRoute } from '@/routes/mediaIntegrations'
import { imgRoute } from '@/routes/img'
import { libraryRoute } from '@/routes/library'
import { plexRoute } from '@/routes/plex'
import { adminHomeAssistant } from '@/routes/adminHomeAssistant'
import { homeAssistantRoute } from '@/routes/homeAssistant'
import { youtubeRoute } from '@/routes/youtube'
import { ytPlaylists } from '@/routes/ytPlaylists'
import { ogMetaMiddleware } from '@/lib/youtube/ogMeta'
import { clipperRoute } from '@/routes/clipper'
import { videosRoute } from '@/routes/videos'
import { videoRss } from '@/routes/videoRss'
import { interestsRoute } from '@/routes/interests'
import { videoStreamRoute } from '@/routes/videoStream'
import mediaCompatRoute from '@/routes/mediaCompat'
import { studioRoute } from '@/routes/videoStudio'
import { podcastsRoute } from '@/routes/podcasts'
import { podcastSubscriptionsRoute } from '@/routes/podcastSubscriptions'
import { podcastPlayerRoute } from '@/routes/podcastPlayer'
import { podcastStats } from '@/routes/podcastStats'
import { podcastPortability } from '@/routes/podcastPortability'
import { podcastRssOut } from '@/routes/podcastRssOut'
import { gpodder } from '@/routes/gpodder'
import { startScrobbleFlusher } from '@/lib/music/scrobble'
import { podcastAiRoute } from '@/routes/podcastAi'
import { music } from '@/routes/music'
import { musicStudio } from '@/routes/musicStudio'
import { musicInfo } from '@/routes/musicInfo'
import { musicRadio } from '@/routes/musicRadio'
import { musicRadioLive } from '@/routes/musicRadioLive'
import { musicCatalog } from '@/routes/musicCatalog'
import { musicStations } from '@/routes/musicStations'
import { musicPlaylists } from '@/routes/musicPlaylists'
import { musicLibrary } from '@/routes/musicLibrary'
import { musicCollection } from '@/routes/musicCollection'
import { musicMeta } from '@/routes/musicMeta'
import { musicRails } from '@/routes/musicRails'
import { musicIntel } from '@/routes/musicIntel'
import { musicScrobble } from '@/routes/musicScrobble'
import { musicImport } from '@/routes/musicImport'
import { musicStats } from '@/routes/musicStats'
import { adminMusicSources } from '@/routes/adminMusicSources'
import { logoRoute } from '@/routes/logo'
import { speedtest } from '@/routes/speedtest'
import { shopping } from '@/routes/shopping'
import { createCodingRoute } from '@/routes/coding'
import { createRemoteRoute } from '@/routes/remote'
import { artifactsRoute } from '@/routes/artifacts'
import adminStorage from '@/routes/adminStorage'
import adminStorageLocations from '@/routes/adminStorageLocations'
import adminBackups from '@/routes/adminBackups'
import adminRemoteAccess from '@/routes/adminRemoteAccess'
import adminHubAddresses from '@/routes/adminHubAddresses'
import hubRoute from '@/routes/hub'
import routinesRoute from '@/routes/routines'
import methodsRoute from '@/routes/methods'
import adminNetworkProtection from '@/routes/adminNetworkProtection'
import mcpAdmin, { mcpPublic } from '@/routes/mcp'
import { adminMcpClient } from '@/routes/adminMcpClient'
import { cast, castMedia } from '@/routes/cast'
import { tvRoute } from '@/routes/tv'
import { shutdownCast } from '@/lib/cast'
import { startYoutubeFeedPoller, backfillAllThumbnails } from '@/lib/youtube/feed'
import { feeds as feedsRoute } from '@/routes/feeds'
import { seedSystemFeeds } from '@/lib/feeds/seed'
import { startFeedPoller, refreshSystemFeeds } from '@/lib/feeds/poller'
import { startPodcastFeedPoller } from '@/lib/podcast/feeds'
import { startYoutubeReconcile } from '@/lib/youtube/reconcile'
import { startYoutubeAccountSync } from '@/lib/youtube/accountSync'
import { backfillYoutubeTitleEntities } from '@/lib/youtube/titleBackfill'
import { startImageCacheMaintenance } from '@/lib/youtube/imageCache'
import { mediaImageCacheSweep } from '@/lib/titles/imageProxy'
import { imageCacheSweep } from '@/lib/imageProxy'
import { startYtdlpAutoUpdate } from '@/lib/ytdlp'
import { startOllamaAutoUpdate } from '@/lib/download'
import { resolveEngineGuards } from '@/lib/engineGuards'
import { whereToWatchRoute } from '@/routes/whereToWatch'
import { dictionaryRoute } from '@/routes/dictionary'
import { titlesRoute } from '@/routes/titles'
import { recipesRoute } from '@/routes/recipes'
import { showtimesRoute } from '@/routes/showtimes'
import { skillsRoute, adminSkillsRoute } from '@/routes/skills'
import { voiceMemosRoute } from '@/routes/voiceMemos'
import { adminRemoteEngineRoute } from '@/routes/adminRemoteEngine'
import { adminCodingFence } from '@/routes/adminCodingFence'
import { loadRemoteEngine } from '@/lib/remoteEngine'
import { medicalRoute } from '@/routes/medical'
import { holidaysRoute } from '@/routes/holidays'
import { localEventsRoute } from '@/routes/localEvents'
import { time } from '@/routes/time'
import { lookup } from '@/routes/lookup'
import { startHomeAssistantSync } from '@/lib/homeAssistant'
import { seedContentProfiles } from '@/lib/contentPolicy'
import { frigate } from '@/routes/frigate'
import { clientPrefs } from '@/routes/clientPrefs'
import { adminFrigate } from '@/routes/adminFrigate'
import { startFrigateMqtt } from '@/lib/frigate/mqtt'
import { monitoring } from '@/routes/monitoring'
import { adminMonitoring } from '@/routes/adminMonitoring'
import { integrationsStatus } from '@/routes/integrationsStatus'
import { icloud } from '@/routes/icloud'
import { features } from '@/routes/features'
import { startMonitoringReconcile } from '@/lib/monitoring/kuma'
import { maybeSpawnComfyUI, stopComfyUI, isComfyUIInstalled } from '@/lib/comfyui'
import { ensureVtracer } from '@/lib/vtracer'
import { maybeSpawnSearXNG, maybeUpdateSearXNG, stopSearXNG } from '@/lib/searxng'
import { maybeSpawnKiwix, scheduleKiwixBootHeal, stopKiwix, maybeUpdateKiwixTools } from '@/lib/kiwix'
import { maybeSpawnVoiceServer, stopVoiceServer } from '@/lib/voiceServer'
import { stopCodingPtySidecar } from '@/lib/codingPtySidecar'
import { reconcileBuiltinPronunciationPacks } from '@/lib/voice/pronunciation'
import { cleanupStaleTrainingTmp } from '@/lib/voice/wakewordTrainer'
import { startPodGateway } from '@/lib/pod/gateway'
import { startPodScheduler } from '@/lib/pod/scheduler'
import { pod } from '@/routes/pod'
import { studio as deviceStudio } from '@/routes/deviceStudio'
// NOTE: the legacy /api/stream-deck route (routes/streamDeck.ts) is retired — the
// controller-layout system replaces it (controller-templates endpoints in deviceStudio.ts
// + controllerStudio.ts). Its old module still imports the dropped stream_deck_* tables,
// so it is intentionally NOT imported here (that would crash boot).
import { browserSessionRoute } from '@/routes/browserSession'
import { watchTogether } from '@/routes/watchTogether'
import { together } from '@/routes/together'
import { maybeBuildWorldGeoJSON, maybeBuildWorldOverview } from '@/lib/maps/toolchain'
import { stopGraphHopper } from '@/lib/maps/graphhopper'
import { listHealthyArchivePaths } from '@/lib/archives'

// ── Boot side effects (once per PROCESS, not per hot-reload) ──────────────────
// `bun --hot` re-evaluates this module on every dev edit but does NOT clear the
// previous graph's timers, sockets, or subprocesses. Unguarded, every edit stacks
// another full boot — duplicate pollers, Ollama warmups, HA registry syncs, process
// handlers (observed: 27 boots in one process = periodic multi-second stalls).
// globalThis survives reloads, so it carries the "already booted" flag. Trade-off:
// changes to anything inside this block need a manual server restart to apply.
const bootFlags = globalThis as typeof globalThis & { __appBooted?: boolean }
const firstBoot = !bootFlags.__appBooted
bootFlags.__appBooted = true

if (firstBoot) {
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
  // Prime the model-set + embedder caches (sync reads on hot paths) and resume any
  // switch that was mid-flight at shutdown. Runs before autotune-dependent warmups.
  import('@/lib/modelSets').then((m) => m.initModelSets()).catch(() => {})
  import('@/llm/embed').then((m) => m.initEmbedModel()).catch(() => {})
  import('@/lib/reembed').then((m) => m.resumeReembedIfPending()).catch(() => {})
  startMemorySweep()
  startBriefingRefresh()
  startCompanionCheckins()
  import('@/lib/chatRetention').then((m) => m.startChatRetentionSweep()).catch(() => {})
  import('@/lib/backup').then((m) => m.startBackupScheduler()).catch(() => {})
  import('@/lib/routines/engine').then((m) => m.startRoutinesEngine()).catch(() => {})
  // Coding-sandbox egress fence is opt-in: reconcile the OS firewall to the stored
  // config on boot (nftables is not persistent across reboots, so a fence re-applies).
  import('@/lib/codingSandboxFirewall').then((m) => m.reconcileEgressFence()).catch(() => {})
  // Discover tools from any configured outbound MCP servers and register them (opt-in;
  // no servers by default). A slow/dead server just contributes no tools.
  import('@/lib/mcp/client').then((m) => m.syncMcpClientTools()).catch(() => {})
  // DNS filtering is opt-in and fail-safe: only starts if the admin enabled it, and
  // a failed bind (needs privilege for :53) is surfaced in the admin UI, not fatal.
  import('@/lib/dns/server').then((m) => m.startDnsServer()).catch(() => {})
  startDropSweep()
  startMediaAlertsSweep()
  startStationCoverBackfill()
  // Weekly parent watch reports (Sunday evenings): see lib/videos/watchReport.ts.
  import('@/lib/videos/watchReport').then((m) => m.startWeeklyWatchReports()).catch(() => {})
  // Semantic video index backfill (recent watch history, slow-paced): semanticIndex.ts.
  import('@/lib/videos/semanticIndex').then((m) => m.startSemanticBackfill()).catch(() => {})
  // Prune expired session rows at boot and hourly so the sessions table doesn't grow
  // unbounded. Expired tokens are already rejected on use; this just reclaims the rows.
  void pruneExpiredSessions().catch(() => {})
  setInterval(() => { void pruneExpiredSessions().catch(() => {}) }, 60 * 60 * 1000)
  // Sweep orphaned wake-word training temp dirs (~25 MB each) left by hard-killed
  // trainings (SIGKILL / run.sh / crash) — their per-run cleanup never got to run.
  void cleanupStaleTrainingTmp().then((n) => { if (n) logger.info(`[wake] cleaned ${n} stale training temp dir(s)`) }).catch(() => {})
  // Warm the model into VRAM at startup — but only once setup has picked one. On a fresh
  // install no model is selected yet, so a warmup would fire a doomed request at an Ollama
  // that may not even be running. setup.ts calls warmupModel() itself once the user chooses.
  void (async () => { if ((await getAppSetting('first_run_complete')) === true) warmupModel() })()
  // Run the boot/verify sequence at startup instead of waiting for the first FRESH
  // page load to hit /api/system/boot — otherwise a restart with only already-open
  // tabs leaves /api/system/ready at 503 indefinitely (boot-gated UI stuck).
  // Fresh installs skip: setup owns installs until first_run_complete, and the
  // wizard's own /boot request starts the sequence at the right moment.
  void (async () => { if ((await getAppSetting('first_run_complete')) === true) startBootSequence() })()
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
  // Start the Uptime Kuma reconcile poll (safety net for events missed while the app
  // was down). No-op unless the integration + reconcile are both enabled. Real-time
  // alerts come via the webhook receiver, not this.
  void startMonitoringReconcile()
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
  // kiwix-tools (Windows) auto-update: roll out newer builds on boot + daily, so a purged
  // pinned version never strands the offline library (mac/Linux use bundled libzim, no-op there).
  void maybeUpdateKiwixTools()
  setInterval(() => void maybeUpdateKiwixTools(true), 24 * 60 * 60 * 1000)
  // Pod gateway: a Wyoming-protocol TCP listener that ESP32 satellites (and the
  // scripts/pod-test-satellite.ts harness) connect to. Reuses STT/TTS/LLM brains.
  // See plans/hardware-devices/pod-wyoming-architecture.md. Disable: POD_GATEWAY_ENABLED=0.
  startPodGateway()
  // Server-side scheduler: fires alarms/timers to a user's connected Pods over the
  // persistent gateway socket (additive to the browser Time app's own firing).
  startPodScheduler()
  // UDP camera frame streamer for screen Pods (bypasses the esp-hosted TCP-inbound
  // stall, #184) — see lib/pod/cameraUdp.ts.
  import('@/lib/pod/cameraUdp').then((m) => m.startCameraUdp()).catch(() => {})
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
      if (valid.length > 0) {
        maybeSpawnKiwix(valid)
        // Self-heal: if the attempt above didn't result in a running server (missing
        // engine, a spawn that silently failed, or state stuck from a prior crash),
        // this makes one more try instead of leaving readers dead for the rest of
        // the process's life with no diagnostic trail.
        scheduleKiwixBootHeal(valid)
      }
    })
    .catch(() => {})
  
  // Resume any background download jobs left pending/running from a prior session,
  // and start the scheduler that drains the queue (≤1 large per host / 2 large total,
  // ≤1 per host, ≤4 network jobs, plus a separate compute lane for map builds).
  void resumeDownloadJobs()
  // Pre-warm lazily-installed binary deps (ffmpeg, Chromium, Node runtime) in the
  // background so first use never stalls on a download — see lib/prewarm.ts.
  import('@/lib/prewarm').then((m) => m.scheduleBinaryPrewarm()).catch(() => {})
  startYoutubeFeedPoller()
  // Doki TV: seed the channel dial and keep 24h of schedule materialized (lib/tv/).
  import('@/lib/tv/scheduler').then((m) => m.initTvScheduler()).catch(() => {})
  // Videos hub: refresh non-YouTube follows + cross-source auto-save (lib/videos/feed.ts).
  import('@/lib/videos/feed').then((m) => m.startVideosFeedPoller()).catch(() => {})
  // Media requests: advance requested→downloading→ready-in-Plex + ready notifications
  // + external Overseerr request sync (lib/media/requestsPoller.ts).
  import('@/lib/media/requestsPoller').then((m) => m.startMediaRequestsPoller()).catch(() => {})
  // Apple iCloud: CalDAV calendar sync (feature-gated inside; ctag-gated per tick).
  import('@/lib/icloud/calendarPoller').then((m) => m.startICloudCalendarPoller()).catch(() => {})
  // Apple iCloud Mail: IMAP IDLE watchers behind the icloud-mail gate (supervisor
  // reconciles connections every minute, so gate toggles need no restart).
  import('@/lib/icloud/mail/watcher').then((m) => m.startICloudMailWatchers()).catch(() => {})
  // Notification delivery layer: deferred/digest flush + daily reports (lib/notify),
  // and the Telegram two-way bridge long-poll loop (lib/telegram).
  import('@/lib/notify/scheduler').then((m) => m.startNotifyScheduler()).catch(() => {})
  import('@/lib/digest/morningReport').then((m) => m.registerMorningReport()).catch(() => {})
  import('@/lib/telegram/poller').then((m) => m.startTelegramPoller()).catch(() => {})
  // Feeds: seed curated News as system feeds, kick an initial fetch, then poll on an interval.
  void seedSystemFeeds().then(() => refreshSystemFeeds()).catch(() => {})
  startFeedPoller()
  // Real podcast subscriptions: refresh RSS shows for new episodes (+ auto-download pass).
  startPodcastFeedPoller()
  // Family audio: weekly parent digest (Monday morning; app_settings key gates reruns).
  startFamilyAudioDigestPoller()
  // AI shows on a daily schedule (e.g. the Household Daily preset): one episode per day.
  import('@/lib/podcast/dailyScheduler').then((m) => m.startPodcastDailyScheduler()).catch(() => {})
  // Scrobbling out: drain the listen outbox to ListenBrainz with retry/backoff. All
  // network I/O for scrobbles lives here, never on a playback path.
  startScrobbleFlusher()
  // Slow back-catalog sweep: RSS only shows the 15 newest items, so anything that scrolls past
  // that window between polls (bursts / extended downtime) is invisible to the poller forever.
  // This re-scans each subscription deeply ~weekly to backfill those missed rows. See reconcile.ts.
  startYoutubeReconcile()
  // Linked YouTube accounts: mirror subscriptions / Watch Later / Liked from Google
  // every 30 min (first pass shortly after boot). See youtube/accountSync.ts.
  startYoutubeAccountSync()
  void backfillAllThumbnails().catch(() => {})
  // One-time: decode HTML entities in titles stored before ingestion-side decoding.
  void backfillYoutubeTitleEntities().catch(() => {})
  // Disk cache for YouTube artwork: evict non-subscribed images 24h after fetch, and
  // conditionally re-validate subscribed channel art every 24h. Runs ~30s after boot too.
  startImageCacheMaintenance()
  // Content blob store: periodically reclaim unreferenced shared media blobs, and fold any
  // pre-dedup per-user offline library into the shared store (idempotent; ~off the hot path so
  // boot/serving isn't blocked on hashing a large library). Both best-effort.
  import('@/lib/content/store').then((m) => m.startContentGc()).catch(() => {})
  setTimeout(() => { void import('@/lib/youtube/migrateOffline').then((m) => m.migrateLegacyOfflineLibrary()) }, 15_000)
  // Bound the Shows/Movies media-image disk cache: sweep oldest art when over the ceiling.
  // Guarded so a sweep that outruns its interval can't overlap itself, and a throwing
  // sweep is logged instead of silently never evicting again.
  const guardedSweep = (label: string, fn: () => Promise<unknown>) => {
    let running = false
    return async () => {
      if (running) return
      running = true
      try { await fn() } catch (e) { logger.warn(`[cache-sweep] ${label} failed: ${e}`) } finally { running = false }
    }
  }
  const mediaSweep = guardedSweep('media-image', mediaImageCacheSweep)
  const imgSweep   = guardedSweep('img-proxy', imageCacheSweep)
  setTimeout(() => void mediaSweep(), 60_000)
  setInterval(() => void mediaSweep(), 24 * 60 * 60 * 1000)
  // Bound the app-wide /api/img proxy cache (news/article/misc remote images).
  setTimeout(() => void imgSweep(), 90_000)
  setInterval(() => void imgSweep(), 24 * 60 * 60 * 1000)
  // Bound the on-demand transcode cache (lib/mediacompat): size-cap LRU + age retention.
  const transcodeSweep = guardedSweep('transcode-cache', () =>
    import('@/lib/mediacompat/store').then((m) => m.transcodeCacheSweep()))
  setTimeout(() => void transcodeSweep(), 150_000)
  setInterval(() => void transcodeSweep(), 24 * 60 * 60 * 1000)
  // Suggestion-rail impression state: reset rotation demotion after idle, drop stale
  // non-dismissed rows (dismissals are kept — see lib/interests/impressions.ts).
  const impressionSweep = guardedSweep('suggestion-impressions', () =>
    import('@/lib/interests/impressions').then((m) => m.sweepImpressions()))
  setTimeout(() => void impressionSweep(), 120_000)
  setInterval(() => void impressionSweep(), 24 * 60 * 60 * 1000)
  // Keep yt-dlp fresh (it breaks against YouTube changes when stale): resolve/provision
  // the binary now, update it if due, then refresh weekly. Best-effort, non-blocking.
  startYtdlpAutoUpdate()
  // Provision the vector tracer for the image generator's SVG output mode. Only where image
  // gen exists (ComfyUI installed), and only a NEW dependency the component-ledger reconcile
  // would otherwise skip on pre-existing installs. Best-effort, non-blocking.
  if (isComfyUIInstalled()) ensureVtracer().catch(() => {})
  // Keep Ollama fresh too: an outdated Ollama can't pull models with a newer manifest
  // format (discovered pulling ornith:9b against 0.30.8). Same daily-check/weekly-force
  // cadence; only upgrades installs it can do safely and unattended (Homebrew or its own
  // managed binary), otherwise just logs a manual-upgrade nudge.
  // Guards first: an auto-update respawn bakes ollamaServeEnv at spawn time, and this can
  // fire before the boot reconcile's own resolveEngineGuards call.
  await resolveEngineGuards().catch(() => {})
  startOllamaAutoUpdate()
  // Opportunistic background band (lib/idleScheduler): load the admin switch into its
  // sync cache so the download scheduler's tick can read it without a DB hit.
  import('@/lib/idleScheduler').then((m) => m.resolveOpportunisticEnabled()).catch(() => {})
  // LLM hygiene watchdog: reap orphaned llama-server runners (children of a crashed/killed
  // `ollama serve` keep squatting VRAM forever and force new loads onto the CPU - observed
  // as a 90-second chat reply). Dead-parent-only matching makes this safe to run blind.
  const orphanSweep = guardedSweep('llama-orphans', () =>
    import('@/lib/ollamaHygiene').then((m) => m.sweepOrphanLlamaRunners('watchdog')))
  setTimeout(() => void orphanSweep(), 45_000)
  setInterval(() => void orphanSweep(), 60_000).unref()

  // Unlike OpenCode's old HTTP sidecars, per-user tmux sessions are DELIBERATELY left
  // running across a backend restart (--hot or a real relaunch alike) — that's the
  // entire point of the tmux-backed design: a user's Claude Code conversation and any
  // in-flight work survive a restart instead of being swept on every boot. No orphan
  // cleanup call here; codingSandboxUser.ts's killSandboxedOrphans() is still
  // available for manual/admin-triggered resets, just no longer fired automatically.

  // Plex: mirror the linked user's media watchlist with their Plex account Watchlist every
  // 15 min (two-way, tombstone-aware). No-op until a Plex server+token is configured.
  import('@/lib/plex/sync').then((m) => m.startPlexWatchlistSync()).catch(() => {})

  // Local music library: incremental rescan of configured folders 90s after boot + daily,
  // so files added outside the app show up without a manual scan. No-op with no folders.
  import('@/lib/music/localLibrary').then((m) => m.startLocalLibrarySweep()).catch(() => {})

  // Karaoke stem cache: delete prepared karaoke tracks unused for 30 days (boot + daily).
  import('@/lib/stems/karaokeCache').then((m) => m.startKaraokeCacheSweep()).catch(() => {})

  // Music intelligence: daily Mixes For You + Family Blend refresh and the offline
  // auto-cache pass (lib/music/intelJobs). Delayed past boot; per-user failures isolated.
  import('@/lib/music/intelJobs').then((m) => m.startMusicIntelJobs()).catch(() => {})

  // Nightly title warm: queue idle-band trivia/reviews precompute for watchlist titles
  // so Movies/Shows detail pages open hot instead of paying a cold web+LLM pass.
  import('@/lib/precompute').then((m) => m.startNightlyTitleWarm()).catch(() => {})

  // Daily-surface warm: Sports and On This Day were cold until their first visitor
  // (a multi-league ESPN fan-out / Wikimedia fetch). Their source modules now cache
  // internally (15m / per-day), so one warm pass at boot + hourly keeps first visits
  // hot; the hourly tick re-fills On This Day right after the date rolls over.
  const surfaceWarm = () => {
    import('@/lib/briefing/sources/sports').then((m) => m.sportsToday({ limit: 8 })).catch(() => {})
    import('@/lib/briefing/sources/onThisDay').then(async (m) => {
      for (const feed of ['selected', 'births', 'deaths'] as const) {
        await m.onThisDay({ limit: 12, feed }).catch(() => {})
      }
    }).catch(() => {})
  }
  setTimeout(surfaceWarm, 75_000)
  setInterval(surfaceWarm, 60 * 60_000).unref()
  
  // Bookmarks capture engine + auto-update pollers all drive server-side headless Chromium
  // against third-party sites, so they only start when the Server Browser Automation feature
  // is enabled. Toggling it off stops future prewarm/archiving without deleting saved data.
  void isFeatureEnabled('browser_session').then((on) => {
    if (!on) return
    // Resolve (and if needed download) a headless Chromium ahead of the first archive so the
    // initial save isn't stalled by a ~150MB install. Best-effort.
    import('@/lib/bookmarks/render').then((m) => m.ensureChromium()).catch(() => {})
    // Periodically re-archive items the user marked for monitoring, and alert on changes.
    import('@/lib/bookmarks/autoUpdate').then((m) => m.startBookmarkAutoUpdatePoller()).catch(() => {})
    // Collection RSS ingest: auto-save new items from feeds a collection subscribes to.
    import('@/lib/bookmarks/collectionRss').then((m) => m.startBookmarkCollectionRssPoller()).catch(() => {})
  })
  // Shopping price tracker: re-check tracked listings on a jittered ~4h cadence and fire
  // price-drop/back-in-stock alerts through the notification matrix.
  import('@/lib/shopping/poller').then((m) => m.startShoppingPoller()).catch(() => {})
  // Self-update checks: periodic git fetch; notify admins or auto-apply per the
  // server.update_check_mode setting (Admin → System → Server). Also clear any
  // stale shutdown sentinel — this process starting means nobody wants it stopped.
  import('@/lib/serverUpdate').then((m) => {
    m.clearStaleShutdownSentinel()
    m.startUpdateCheckPoller()
  }).catch(() => {})
  // Books: warm the Discover/Magazines/Audiobooks browse caches so the first visit
  // after a restart is instant instead of a multi-second remote fan-out.
  import('@/lib/books/warm').then((m) => m.warmBookCaches()).catch(() => {})
} else {
  // Hot reload: module-level caches reset with the new graph even though the old
  // timers/sockets keep running. Re-seed the cheap ones the request path depends on.
  void loadRemoteEngine()
}

// Ollama models are deliberately LEFT resident on shutdown (they load with
// keep_alive: -1). Unloading them here made every app relaunch pay a full multi-GB
// re-warm — measured at ~60-70s to /api/system/ready — even though `ollama serve`
// outlives the backend (the launcher leaves it running across restarts), so the warm
// models are still in VRAM on the next boot. Keeping them resident makes a relaunch
// effectively instant. VRAM is reclaimed on a real exit (uninstall unloads explicitly)
// or by Ollama's own idle eviction if keep_alive is ever relaxed.

// Kill the spawned sidecars on shutdown so they don't outlive the backend and hold
// their ports (which would make the next boot's spawn fail with "port in use"). Each
// is wrapped so one failing doesn't block the rest.
async function stopSidecars() {
  try { await stopKiwix() } catch { /* best-effort */ }
  try { stopComfyUI() } catch { /* best-effort */ }
  try { stopSearXNG() } catch { /* best-effort */ }
  try { stopVoiceServer() } catch { /* best-effort */ }
  try { shutdownCast() } catch { /* best-effort */ }
  // Deliberately NOT killing per-user tmux sessions here: they're meant to survive a
  // backend restart (that's the whole point of tmux-backed persistence) — only the
  // stateless PTY-attach sidecar needs to go down.
  try { stopCodingPtySidecar() } catch { /* best-effort */ }
  try { stopGraphHopper() } catch { /* best-effort */ }
}

async function shutdown() {
  // Note: Ollama models are intentionally NOT unloaded here — see comment above.
  await stopSidecars()
  process.exit(0)
}

// Deliberate self-exits (admin restart / self-update) need the same sidecar
// teardown, but their routes can't import this module without a cycle.
registerSidecarStopper(stopSidecars)

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())

// Last-resort crash telemetry: an uncaught throw from a timer/poller or a floating
// promise otherwise kills the process with the reason only on the (scrolled-away)
// terminal — app.log must record what took the server down. Rejections are logged but
// survivable; uncaughtException state is undefined, so log synchronously and exit.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason instanceof Error ? reason : new Error(String(reason)) }, '[process] unhandled promise rejection')
})
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, '[process] uncaught exception — exiting')
  // logger's file sink is async and may not flush before exit; append the line sync.
  try {
    appendFileSync(join(dataDir, 'logs', 'app.log'),
      JSON.stringify({ level: 60, time: Date.now(), msg: `[process] uncaught exception: ${err?.stack ?? err}` }) + '\n')
  } catch { /* best-effort */ }
  process.exit(1)
})

const app = new Hono()

// Bun WebSocket adapter — `websocket` MUST be on the default export below or
// `server.upgrade` silently fails and the STT socket never connects.
const { upgradeWebSocket, websocket } = createBunWebSocket()

if (process.env.NODE_ENV === 'development') {
  app.use('*', cors({ origin: 'http://localhost:5173', credentials: true }))
}

app.use('*', requestLogger)

// API responsiveness probe (Phase 2.8): time non-streaming API requests so p95 web
// latency is visible in Admin > System. SSE/WS and static assets are excluded (their
// wall-time is the client's, not a server-responsiveness signal).
app.use('/api/*', async (c, next) => {
  const t0 = performance.now()
  await next()
  const ct = c.res.headers.get('content-type') ?? ''
  const p = c.req.path
  if (ct.includes('text/event-stream') || p.includes('/stream') || p.endsWith('/terminal')) return
  // Image proxies fire ~100-200 times per home-screen render and would drown the p95.
  if (p.startsWith('/api/youtube/img') || p.startsWith('/api/youtube/dearrow-thumb')) return
  recordApiLatency(performance.now() - t0)
})

// gzip JSON API responses (see middleware/compress.ts). Registered after the latency probe
// so it wraps the routes directly and the recorded time includes compression.
app.use('/api/*', gzipJson)

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

// Hub discovery: /api/hub/ping is what every client fires at each of its cached
// addresses on startup, so it sits up here with health, ahead of the capability gates.
app.route('/api/hub', hubRoute)

// ── Capability gates ────────────────────────────────────────────────────────────
// Enforce the admin feature toggles at the backend boundary: a disabled feature's HTTP
// routes 403 and its WebSocket handshake is refused here (the upgrade is a normal GET, so
// this middleware runs before it completes). Registered BEFORE the mounts below so it
// matches first. Token routes (opds/kosync) are gated before their token resolution runs.
// Per-profile authorization for remote/coding is enforced inside their WS handlers, where
// the session user is resolved. See lib/featureGate.ts.
app.use('/api/remote/*', requireFeature('remote'))
app.use('/api/coding/*', requireFeature('coding'))
app.use('/api/clipper/*', requireFeature('media_downloads'))
app.use('/api/browser-session/*', requireFeature('browser_session'))
app.use('/api/opds/*', requireFeature('opds'))
app.use('/api/kosync/*', requireFeature('kosync'))
app.use('/api/lookup/*', requireFeature('people_lookup'))

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
app.route('/api/memory', memory)
app.route('/api/admin/latency-test', adminLatencyTest)
app.route('/api/admin/chat-benchmark', adminChatBenchmark)
app.route('/api/admin/router-benchmark', adminRouterBenchmark)
app.route('/api/projects', projects)
app.route('/api/image', image)
app.route('/api/converter', converter)
app.route('/api/drop', drop)
app.route('/api/desktop', desktopApp)
app.route('/api/admin/image-loras', adminImageLoras)
app.route('/api/admin/queue', adminQueue)
app.route('/api/admin/gpu', adminGpu)
app.route('/api/admin/media', adminMedia)
app.route('/api/admin/install', adminInstall)
app.route('/api/admin/model-sets', adminModelSets)
app.route('/api/admin/uninstall', adminUninstall)
app.route('/api/admin/server', adminServer)
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
app.route('/api/pod', deviceStudio)
// app.route('/api/stream-deck', streamDeck)  // retired — see controller-layout system
app.route('/api/browser-session', browserSessionRoute)
app.route('/api/watch-together', watchTogether)
// Listening Together: player presence, phone-as-remote commands, Family Jam queue.
app.route('/api/together', together)
app.route('/api/bookmarks', bookmarks)
app.route('/api/admin/bookmarks', adminBookmarks)
app.route('/api/notes', notesRouter)
app.route('/api/clipper', clipperRoute)
app.route('/api/narration', narration)
app.route('/api/writing-tools', writingToolsRoute)
app.route('/api/translate', translateRoute)
app.route('/api/books', books)
app.route('/api/books', booksGenerate)
app.route('/api/admin/books', adminBooks)
// KOReader progress-sync server (header-authed, no app session) — point KOReader's
// custom sync server at /api/kosync. See routes/kosync.ts.
app.route('/api/kosync', kosync)
// OPDS 1.2 catalog server (per-user token in the URL, no app session) — add
// /api/opds/<token> to any OPDS reader. See routes/opds.ts.
app.route('/api/opds', opds)
// Deprecated alias: archives captured before the Reader→Bookmarks rename baked
// `/api/reader/<id>/archive/*` asset URLs into their saved HTML. Keep serving them.
app.route('/api/reader', bookmarks)
app.route('/api/search', searchRouter)
app.route('/api/search/web', webSearchRouter)
app.route('/api/app-features', appFeatures)
app.route('/api/admin/briefing', adminBriefing)
app.route('/api/briefing', briefing)
app.route('/api/push', push)
app.route('/api/maps', maps)
app.route('/api/admin/maps', adminMaps)
app.route('/api/proxy', proxy)
app.route('/api/vision', vision)
app.route('/api/bored', bored)
app.route('/api/home', home)
app.route('/api/privacy', privacy)
app.route('/api/admin/content', adminContent)
app.route('/api/content', content)
app.route('/api/family-audio', familyAudio)
app.route('/api/admin/family-audio', adminFamilyAudio)
app.route('/api/consent', consent)
app.route('/api/admin/locale', adminLocale)
app.route('/api/admin/speedtest', adminSpeedtest)
app.route('/api/notifications', notificationsRoute)
app.route('/api/notify', notifyChannels)
app.route('/api/admin/notify', adminNotify)
app.route('/api/app-store', appStore)
app.route('/api/home-layout', homeLayout)
app.route('/api/media-progress', mediaProgress)
app.route('/api/admin/connectivity', adminConnectivity)
app.route('/api/news', news)
app.route('/api/admin/news', adminNews)
app.route('/api/feeds', feedsRoute)
app.route('/api/on-this-day', onThisDayRoute)
app.route('/api/sports/today', sportsTodayRoute)
app.route('/api/sports', sportsRoute)
app.route('/api/jokes', jokesDedicatedRoute)
app.route('/api/tv-shows', tvShowsRoute)
app.route('/api/shows', showsRoute)
app.route('/api/movies', moviesRoute)
app.route('/api/media', mediaRoute)
app.route('/api/media-integrations', mediaIntegrationsRoute)
app.route('/api/img', imgRoute)
app.route('/api/library', libraryRoute)
app.route('/api/plex', plexRoute)
app.route('/api/admin/home-assistant', adminHomeAssistant)
app.route('/api/home-assistant', homeAssistantRoute)
app.route('/api/frigate', frigate)
app.route('/api/admin/frigate', adminFrigate)
app.route('/api/monitoring', monitoring)
app.route('/api/client-prefs', clientPrefs)
app.route('/api/admin/monitoring', adminMonitoring)
app.route('/api/integrations', integrationsStatus)
app.route('/api/icloud', icloud)
app.route('/api/features', features)
app.route('/api/videos/studio', studioRoute)
app.route('/api/videos', videosRoute)
// Per-user video RSS feeds (token in the URL, no app session) — point any RSS reader at
// /api/video-rss/<token>/... A separate mount because /api/videos requires a session.
app.route('/api/video-rss', videoRss)
app.route('/api/interests', interestsRoute)
app.route('/api/vstream', videoStreamRoute)
app.route('/api/compat', mediaCompatRoute)
app.route('/api/youtube', youtubeRoute)
app.route('/api/youtube/playlists', ytPlaylists)
app.route('/api/podcasts', podcastAiRoute)
app.route('/api/podcasts', podcastPlayerRoute)
app.route('/api/podcasts', podcastSubscriptionsRoute)
app.route('/api/podcasts', podcastStats)
app.route('/api/podcasts/portability', podcastPortability)
app.route('/api/podcasts', podcastsRoute)
// Private RSS feeds out (token in the URL, no session) so any LAN podcatcher can
// subscribe to a generated show or the radio recordings. See routes/podcastRssOut.ts.
app.route('/api/podcast-rss', podcastRssOut)
// gpodder.net-compatible sync (AntennaPod). Mounted at the ROOT because the protocol
// fixes its paths at /api/2/* and /subscriptions/* and clients take a bare host, not a
// path prefix. Basic-auth on every call; no /api/2 or /subscriptions app route exists
// to collide with. See routes/gpodder.ts.
app.route('/', gpodder)
app.route('/api/music', music)
app.route('/api/music/studio', musicStudio)
app.route('/api/music/info', musicInfo)
app.route('/api/music/radio/live', musicRadioLive)
app.route('/api/music/radio', musicRadio)
app.route('/api/music/catalog', musicCatalog)
app.route('/api/music/stations', musicStations)
app.route('/api/music/playlists', musicPlaylists)
app.route('/api/music/library', musicLibrary)
app.route('/api/music/collection', musicCollection)
app.route('/api/music/meta', musicMeta)
app.route('/api/music/rails', musicRails)
app.route('/api/music/intel', musicIntel)
app.route('/api/music/scrobble', musicScrobble)
app.route('/api/music/import', musicImport)
app.route('/api/music/stats', musicStats)
app.route('/api/admin/music', adminMusicSources)
app.route('/api/logo', logoRoute)
app.route('/api/speedtest', speedtest)
app.route('/api/shopping', shopping)
app.route('/api/coding', createCodingRoute(upgradeWebSocket))
app.route('/api/remote', createRemoteRoute(upgradeWebSocket))
app.route('/api/artifacts', artifactsRoute)
app.route('/api/where-to-watch', whereToWatchRoute)
app.route('/api/dictionary', dictionaryRoute)
app.route('/api/titles', titlesRoute)
app.route('/api/recipes', recipesRoute)
app.route('/api/showtimes', showtimesRoute)
app.route('/api/skills', skillsRoute)
app.route('/api/admin/users', adminSkillsRoute)
app.route('/api/voice/memos', voiceMemosRoute)
app.route('/api/admin/remote-engine', adminRemoteEngineRoute)
app.route('/api/admin/coding-fence', adminCodingFence)
app.route('/api/medical', medicalRoute)
app.route('/api/holidays', holidaysRoute)
app.route('/api/local-events', localEventsRoute)
app.route('/api/time', time)
app.route('/api/lookup', lookup)
app.route('/api/admin/storage', adminStorage)
app.route('/api/admin/storage-locations', adminStorageLocations)
app.route('/api/admin/backups', adminBackups)
app.route('/api/admin/remote-access', adminRemoteAccess)
app.route('/api/admin/hub-addresses', adminHubAddresses)
app.route('/api/routines', routinesRoute)
app.route('/api/methods', methodsRoute)
app.route('/api/admin/network-protection', adminNetworkProtection)
app.route('/api/admin/mcp', mcpAdmin)
app.route('/api/admin/mcp-client', adminMcpClient)
app.route('/api/mcp', mcpPublic)
app.route('/api/cast', cast)
app.route('/api/cast-media', castMedia)
app.route('/api/tv', tvRoute)

// Docs site — served at /docs/* in both dev and prod (static, no auth required)
app.use('/docs/*', serveStatic({ root: '../docs/dist', rewriteRequestPath: (p) => p.replace(/^\/docs/, '') || '/' }))

if (process.env.NODE_ENV !== 'development') {
  app.get('/videos/youtube/watch/:videoId', ogMetaMiddleware)
  // Legacy path: old shared links still resolve OG tags before the SPA redirect kicks in.
  app.get('/youtube/watch/:videoId', ogMetaMiddleware)
  app.use('*', serveStatic({ root: '../frontend/dist' }))
  app.get('*', serveStatic({ path: '../frontend/dist/index.html' }))
}

// At-rest secret encryption (lib/secrets.ts) and the PIN pepper (lib/pin.ts) fall back, when
// no env key is set, to a key kept OUTSIDE the database by the keystore (data/keys/, or the
// macOS Keychain / a Windows DPAPI-wrapped file). That already protects against DB-file theft
// and backups (which snapshot only the DB). A dedicated env var is still the strongest option:
// it survives a full data-dir wipe and keeps the key off the host entirely if sourced from a
// secret manager. Nudge the operator toward it, but this is no longer a standing exposure.
if (!process.env.SECRETS_KEY || !process.env.PIN_PEPPER) {
  const missing = [!process.env.SECRETS_KEY && 'SECRETS_KEY', !process.env.PIN_PEPPER && 'PIN_PEPPER'].filter(Boolean).join(' and ')
  logger.info(`[security] ${missing} not set — using the file/OS keystore under data/keys/ (kept out of the DB and backups). Set ${missing} (see docs) for the strongest separation.`)
}

const port = parseInt(process.env.PORT ?? '3000')

// This is a household LAN appliance: wall displays, Pods, and family phones all reach the
// server over the LAN, so the default bind is all interfaces (0.0.0.0). A security-conscious
// operator can pin it — e.g. HOST=127.0.0.1 when a same-box reverse proxy terminates TLS.
// The bind address only controls which interfaces answer; it does NOT put the app on the
// public internet. Internet exposure requires the operator to deliberately port-forward /
// reverse-proxy, which should always terminate TLS (session cookies are Secure only over
// HTTPS) and add its own authentication.
const hostname = process.env.HOST ?? '0.0.0.0'
if (hostname === '0.0.0.0' || hostname === '::') {
  logger.info(`loki-doki running on http://localhost:${port} (also reachable on your LAN at http://<this-machine-ip>:${port}). Do not port-forward this port to the internet without a TLS reverse proxy in front.`)
} else {
  logger.info(`loki-doki running on http://${hostname}:${port}`)
}

// websocket.idleTimeout: Bun auto-pings each WS client and closes any that hasn't sent
// a frame (a pong counts) within this window — measured: close 1006 "WebSocket timed out
// from inactivity" at exactly 120s (the default). Browsers only pong while the page is
// awake, so a locked phone or backgrounded tab looked "dead" after 2 minutes and its
// VNC/RDP/terminal session was reaped. 960 (Bun's max, 16 min) rides out normal
// screen-off gaps; genuinely dead clients still get collected, just later — acceptable
// for a LAN appliance. The trailing idleTimeout: 0 is the separate HTTP-request timeout.
export default { port, hostname, fetch: app.fetch, websocket: { ...websocket, idleTimeout: 960 }, idleTimeout: 0 }
