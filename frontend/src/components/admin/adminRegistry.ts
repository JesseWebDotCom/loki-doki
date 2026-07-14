import type { LucideIcon } from 'lucide-react'
import { Users, Settings2, LayoutGrid, ChevronRight, Sparkles, ShieldCheck, Store, LayoutDashboard, Newspaper, Cpu, Plug2, BellRing, Music2 } from 'lucide-react'

// Single source of truth for the admin panel: drives the sidebar tree, the search
// filter, and the Cmd+K palette. Each section maps to a tab component; subsections are
// URL-addressable (`/admin/:section/:subId`) and connect to content one of three ways:
//   - 'view'   → passed as a prop that drives the tab's internal view state
//   - 'anchor' → scrolls to `anchorId` within a single-page tab
//   - (no subs) → the section is a single view
export type SubKind = 'view' | 'anchor'

export interface AdminSubsection {
  id: string
  label: string
  keywords: string[]
  kind: SubKind
  anchorId?: string
  description?: string
}

export interface AdminSection {
  id: string
  label: string
  icon: LucideIcon
  keywords: string[]
  description?: string
  subsections: AdminSubsection[]
}

export const ADMIN_SECTIONS: AdminSection[] = [
  {
    id: 'overview', label: 'Overview', icon: LayoutDashboard,
    keywords: ['overview', 'dashboard', 'home', 'stats', 'status', 'summary', 'health'],
    description: 'At-a-glance status, key metrics, and quick actions',
    subsections: [],
  },
  {
    id: 'system', label: 'System', icon: Settings2,
    keywords: ['system', 'server', 'connectivity', 'offline', 'downloads', 'home', 'layout'],
    description: 'Connectivity, home layout, locale, and server maintenance',
    subsections: [
      { id: 'connectivity', label: 'Connectivity', kind: 'anchor', anchorId: 'connectivity',
        keywords: ['network', 'offline', 'online', 'internet', 'downloads', 'queue'],
        description: 'Online/offline mode and download permissions' },
      { id: 'locale', label: 'Locale & Units', kind: 'anchor', anchorId: 'locale',
        keywords: ['units', 'temperature', 'currency', 'time', 'measurement', 'metric', 'imperial'],
        description: 'Measurement units, temperature, currency, time format' },
      { id: 'home-layout', label: 'Home Layout', kind: 'anchor', anchorId: 'home-layout',
        keywords: ['home', 'layout', 'widgets', 'default', 'dashboard', 'per user', 'lock'],
        description: 'Default and per-user home dashboard layout' },
      { id: 'speed-test', label: 'Speed Test', kind: 'anchor', anchorId: 'speed-test',
        keywords: ['speed', 'threshold', 'mbps', 'good', 'ok', 'slow', 'rating', 'bandwidth', 'internet'],
        description: 'Download speed thresholds that color-code Speed Test results and the home widget' },
      { id: 'server', label: 'Server', kind: 'anchor', anchorId: 'server',
        keywords: ['restart', 'reboot', 'update', 'upgrade', 'version', 'git', 'commit', 'maintenance'],
        description: 'Version info, updates, and restarting the server' },
      { id: 'uninstall', label: 'Uninstall', kind: 'anchor', anchorId: 'uninstall',
        keywords: ['wipe', 'reset', 'delete', 'remove', 'factory'],
        description: 'Remove the app and wipe its data' },
    ],
  },
  {
    id: 'features', label: 'Features', icon: LayoutGrid,
    keywords: ['features', 'models', 'downloads', 'capabilities', 'install'],
    description: 'Enable capabilities and manage model downloads',
    subsections: [
      { id: 'chat', label: 'Chat & Intelligence', kind: 'anchor', anchorId: 'section-chat',
        keywords: ['chat', 'llm', 'language model', 'smart tools', 'vision', 'see images', 'embeddings', 'ollama'],
        description: 'Language model, vision, embeddings, and routing' },
      { id: 'images', label: 'Image Generation', kind: 'anchor', anchorId: 'section-images',
        keywords: ['images', 'comfyui', 'stable diffusion', 'lora', 'video', 'upscale', 'face'],
        description: 'Image and video generation models and LoRA styles' },
      { id: 'voice', label: 'Voice', kind: 'anchor', anchorId: 'section-voice',
        keywords: ['voice', 'tts', 'stt', 'whisper', 'kokoro', 'wake word', 'speech'],
        description: 'Text-to-speech and speech-to-text models' },
      { id: 'capabilities', label: 'Capabilities', kind: 'anchor', anchorId: 'section-capabilities',
        keywords: ['home inventory', 'tesseract', 'ocr', 'wakeword', 'wake word', 'capabilities'],
        description: 'Home Inventory, Voice, and Wake Word add-ons' },
    ],
  },
  {
    id: 'apps', label: 'Apps', icon: Store,
    keywords: ['apps', 'extensions', 'install', 'store'],
    description: 'Apps, install requests, and settings',
    subsections: [
      { id: 'requests', label: 'Install Requests', kind: 'anchor', anchorId: 'requests',
        keywords: ['install', 'requests', 'notifications', 'approve', 'pending'],
        description: 'Pending install requests from users' },
      { id: 'app-settings', label: 'App Settings', kind: 'anchor', anchorId: 'app-settings',
        keywords: ['apps', 'extensions', 'config', 'api key', 'secret', 'permissions', 'home assistant', 'youtube', 'who can use', 'enable', 'disable'],
        description: 'Per-app configuration, API keys, and per-user permissions' },
    ],
  },
  {
    id: 'companions', label: 'Companions', icon: Sparkles,
    keywords: ['companion', 'voice', 'wakeword', 'briefing', 'tts'],
    description: 'Instance-wide voice, wake words, and daily briefing (character studio lives in the Companions app)',
    subsections: [
      { id: 'voice', label: 'Voice & Wake words', kind: 'view',
        keywords: ['voice', 'tts', 'wakeword', 'wake word', 'speech', 'piper', 'hey', 'trigger', 'microphone'],
        description: 'Default voice and wake-word settings' },
      { id: 'briefing', label: 'Daily Briefing', kind: 'view',
        keywords: ['briefing', 'news', 'weather', 'ambient', 'context', 'sports'],
        description: 'Ambient world and local context for companions' },
    ],
  },
  {
    id: 'news', label: 'News', icon: Newspaper,
    keywords: ['news', 'rss', 'feed', 'category', 'categories', 'headlines', 'shared'],
    description: 'Shared News categories and their RSS feeds (visible to everyone)',
    subsections: [],
  },
  {
    id: 'music', label: 'Music', icon: Music2,
    keywords: ['music', 'library', 'collection', 'folder', 'folders', 'scan', 'local', 'flac', 'mp3', 'lossless', 'plex music', 'sources'],
    description: 'Music sources: local library folders (and Plex music sections)',
    subsections: [
      { id: 'sources', label: 'Sources', kind: 'anchor', anchorId: 'sources',
        keywords: ['folder', 'folders', 'local', 'scan', 'library', 'plex', 'nas', 'path'],
        description: 'Local music folders and Plex music sections' },
    ],
  },
  {
    id: 'notifications', label: 'Notifications', icon: BellRing,
    keywords: ['notifications', 'push', 'telegram', 'email', 'smtp', 'bot', 'digest', 'delivery', 'alerts', 'quiet hours', 'vapid'],
    description: 'Delivery channels: Telegram bot, email (SMTP), web push, and the delivery log',
    subsections: [
      { id: 'telegram', label: 'Telegram Bot', kind: 'anchor', anchorId: 'telegram',
        keywords: ['bot', 'botfather', 'token', 'chat', 'telegram'],
        description: 'Household bot for notifications and companion chat' },
      { id: 'email', label: 'Email (SMTP)', kind: 'anchor', anchorId: 'email',
        keywords: ['smtp', 'mail', 'email', 'sender', 'app password'],
        description: 'SMTP account for email notifications and summaries' },
      { id: 'web-push', label: 'Web Push', kind: 'anchor', anchorId: 'web-push',
        keywords: ['vapid', 'browser', 'pwa', 'push', 'device'],
        description: 'Browser/device push status and app URL' },
      { id: 'log', label: 'Delivery Log', kind: 'anchor', anchorId: 'log',
        keywords: ['log', 'failures', 'health', 'history', 'deliveries'],
        description: 'Recent delivery attempts and channel health' },
    ],
  },
  {
    id: 'devices', label: 'Devices', icon: Cpu,
    keywords: ['devices', 'pod', 'pods', 'esp32', 'satellite', 'hardware', 'pairing', 'pair', 'wake word', 'echo', 'dot', 'show', 'watch', 'wyoming'],
    description: 'Set up and manage your voice devices around the home',
    subsections: [
      {
        id: 'overview', label: 'My Devices', kind: 'view',
        keywords: ['devices', 'device', 'list', 'pod', 'pods', 'satellite', 'pair', 'pairing', 'echo', 'tab5', 'screen', 'speaker', 'voice'],
        description: 'Your voice devices around the home',
      },
      {
        id: 'layouts', label: 'Layouts', kind: 'view',
        keywords: ['layout', 'layouts', 'grid', 'slot', 'widgets', 'template', 'profile', 'theme', 'dashboard', 'tab5', 'clock', 'weather', 'home', 'screen', 'display', 'ambient', 'kiosk', 'wallpaper', 'flip clock', 'date', 'background', 'controller', 'button grid'],
        description: 'Layout templates for display and controller modes',
      },
      {
        id: 'sounds', label: 'Sounds', kind: 'view',
        keywords: ['sound', 'sounds', 'earcon', 'chime', 'chimes', 'tone', 'pack', 'wake sound', 'beep', 'audio', 'alarm', 'alarms', 'wake up', 'ring', 'snooze', 'schedule'],
        description: 'Sound packs, earcons, and the chime designer',
      },
      {
        id: 'settings', label: 'Settings', kind: 'view',
        keywords: ['settings', 'central', 'dimming', 'brightness', 'group', 'groups', 'camera test', 'manual', 'pairing code', 'advanced'],
        description: 'Central settings, camera test, and manual pairing',
      },
    ],
  },
  {
    id: 'integrations', label: 'Integrations', icon: Plug2,
    keywords: ['integrations', 'frigate', 'plex', 'home assistant', 'nvr', 'camera', 'media', 'smart home', 'mqtt', 'hass', 'cctv', 'security', 'books', 'opds'],
    description: 'External service integrations — Frigate NVR, Plex, Home Assistant, and Books',
    subsections: [
      {
        id: 'frigate', label: 'Frigate', kind: 'view',
        keywords: ['frigate', 'nvr', 'camera', 'cameras', 'cctv', 'security', 'genai', 'license plate', 'lpr', 'delivery', 'mqtt'],
        description: 'Frigate NVR — VLM GenAI provider, camera event notifications and announcements',
      },
      {
        id: 'monitoring', label: 'Monitoring', kind: 'view',
        keywords: ['monitoring', 'uptime', 'kuma', 'uptime kuma', 'status', 'health', 'down', 'alerts', 'webhook', 'service', 'server', 'outage'],
        description: 'Uptime Kuma — get told (and have the companion announce) when a service or server goes down',
      },
      {
        id: 'plex', label: 'Plex', kind: 'view',
        keywords: ['plex', 'media', 'server', 'watchlist', 'library', 'movies', 'shows', 'streaming', 'token', 'pin'],
        description: 'Link your Plex Media Server — library rails, two-way Watchlist sync, and in-app playback',
      },
      {
        id: 'home-assistant', label: 'Home Assistant', kind: 'view',
        keywords: ['home assistant', 'hass', 'smart home', 'iot', 'devices', 'entities', 'areas', 'automation', 'lights', 'thermostat'],
        description: 'Connect Home Assistant for smart-home control via the companion',
      },
      {
        id: 'books', label: 'Books', kind: 'view',
        keywords: ['books', 'opds', 'ebook', 'calibre', 'kavita', 'indexer', 'catalog', 'discover'],
        description: 'Optional self-hosted OPDS indexers as extra Book Store sources',
      },
    ],
  },
  {
    id: 'security', label: 'Security', icon: ShieldCheck,
    keywords: ['security', 'privacy', 'safety', 'content', 'nsfw', 'adult', 'pin', 'profiles', 'filtering', 'styles', 'uncensored'],
    description: 'Style flags, filtering, and privacy mode',
    subsections: [
      { id: 'styles', label: 'Styles', kind: 'view',
        keywords: ['lora', 'style', 'adult', 'flag', 'rescan', 'image'],
        description: 'Manually mark image styles as adult' },
      { id: 'filtering', label: 'Filtering', kind: 'view',
        keywords: ['keywords', 'adult', 'detection', 'lora', 'nsfw', 'scan', 'filter'],
        description: 'Keywords used to flag adult image styles at import' },
      { id: 'privacy-mode', label: 'Privacy Mode', kind: 'view',
        keywords: ['pin', 'hide', 'reveal', 'privacy', 'lock', 'timeout'],
        description: 'PIN-gated hiding of adult styles and generated content' },
      { id: 'consent', label: 'Consent', kind: 'view',
        keywords: ['consent', 'uncensored', 'internet', 'offline', 'companions', 'liability', 'permissions'],
        description: 'User consent for risky capabilities' },
    ],
  },
  {
    id: 'users', label: 'Users', icon: Users,
    keywords: ['users', 'accounts', 'roles', 'admin', 'members', 'storage', 'profiles', 'content'],
    description: 'User accounts, content profiles, and storage',
    subsections: [
      { id: 'accounts', label: 'Accounts', kind: 'anchor', anchorId: 'accounts',
        keywords: ['users', 'accounts', 'roles', 'memory', 'protections', 'style', 'clear memory'],
        description: 'Manage user accounts and per-user settings' },
      { id: 'profiles', label: 'Content Profiles', kind: 'anchor', anchorId: 'profiles',
        keywords: ['profiles', 'content', 'ceiling', 'dials', 'profanity', 'sexual', 'violence', 'nsfw', 'adult', 'uncensored', 'unrestricted', 'censored'],
        description: 'Named per-category content ceilings assigned to users' },
      { id: 'storage', label: 'Storage', kind: 'anchor', anchorId: 'storage',
        keywords: ['storage', 'disk', 'cleanup', 'space', 'usage'],
        description: 'Disk usage and cleanup' },
      { id: 'storage-locations', label: 'Storage Locations', kind: 'anchor', anchorId: 'storage-locations',
        keywords: ['storage', 'locations', 'network', 'unc', 'nas', 'plex', 'path', 'mapping'],
        description: 'Per-content-type storage roots, incl. network paths, and Plex path mappings' },
    ],
  },
  {
    id: 'advanced', label: 'Advanced', icon: ChevronRight,
    keywords: ['advanced', 'diagnostics', 'logs', 'debug', 'troubleshoot'],
    description: 'Diagnostics and live logs',
    subsections: [
      { id: 'diagnostics', label: 'Diagnostics', kind: 'view',
        keywords: ['diagnostics', 'health', 'queue', 'troubleshoot', 'system', 'status'],
        description: 'System health and generation queue' },
      { id: 'logs', label: 'Logs', kind: 'view',
        keywords: ['logs', 'app logs', 'comfy', 'debug', 'stream'],
        description: 'Live application and ComfyUI logs' },
    ],
  },
  {
    id: 'engine', label: 'Engine', icon: Cpu,
    keywords: ['engine', 'remote', 'ollama', 'gpu', 'offload', 'inference', 'llm', 'host'],
    description: 'Run inference on a remote Ollama host',
    subsections: [],
  },
]

export function findSection(id: string | undefined): AdminSection | undefined {
  return ADMIN_SECTIONS.find((s) => s.id === id)
}

export function defaultSub(sectionId: string): string | undefined {
  return findSection(sectionId)?.subsections[0]?.id
}

export function findSubsection(sectionId: string, subId: string | undefined): AdminSubsection | undefined {
  if (!subId) return undefined
  return findSection(sectionId)?.subsections.find((s) => s.id === subId)
}

export interface SearchHit {
  sectionId: string
  subId?: string
  label: string
  breadcrumb: string
  description?: string
  anchorId?: string
  score: number
}

// Rank: label prefix > label substring > keyword > description. Returns best-first.
export function searchSettings(query: string): SearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hits: SearchHit[] = []

  const score = (label: string, keywords: string[], description: string | undefined): number => {
    const l = label.toLowerCase()
    if (l.startsWith(q)) return 100
    if (l.includes(q)) return 80
    if (keywords.some((k) => k.toLowerCase().includes(q))) return 60
    if (description && description.toLowerCase().includes(q)) return 40
    return 0
  }

  for (const section of ADMIN_SECTIONS) {
    if (section.subsections.length === 0) {
      const s = score(section.label, section.keywords, section.description)
      if (s > 0) hits.push({ sectionId: section.id, label: section.label, breadcrumb: section.label, description: section.description, score: s })
    }
    for (const sub of section.subsections) {
      const s = score(sub.label, [...sub.keywords, ...section.keywords], sub.description)
      if (s > 0) {
        hits.push({
          sectionId: section.id, subId: sub.id, label: sub.label,
          breadcrumb: section.label, description: sub.description,
          anchorId: sub.anchorId, score: s,
        })
      }
    }
  }
  return hits.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
}

// All leaf entries (sections without subs + every subsection), for the empty palette state.
export function allEntries(): SearchHit[] {
  const hits: SearchHit[] = []
  for (const section of ADMIN_SECTIONS) {
    if (section.subsections.length === 0) {
      hits.push({ sectionId: section.id, label: section.label, breadcrumb: section.label, description: section.description, score: 0 })
    }
    for (const sub of section.subsections) {
      hits.push({ sectionId: section.id, subId: sub.id, label: sub.label, breadcrumb: section.label, description: sub.description, anchorId: sub.anchorId, score: 0 })
    }
  }
  return hits
}
