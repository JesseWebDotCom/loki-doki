import { useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { SkipForward, Sparkles, Wand2, Type, FileText, Rss, Bot, Play, Plug, ShieldCheck, Server, ArrowLeftRight, EyeOff } from 'lucide-react'
import { AppSettingsShell, type AppSettingsSection } from '@/components/shared/AppSettingsShell'
import { getAppByPath } from '@/lib/appCategories'
import {
  SettingsYoutubeChannels, SettingsYoutubeAutoSkip, SettingsYoutubeVideoQuality,
  SettingsYoutubeTitlesThumbnails, SettingsYoutubeDescriptions, SettingsYoutubeHiddenContent,
} from '@/components/settings/SettingsYoutubeTab'
import { SettingsVideoSources } from '@/components/settings/SettingsVideoSources'
import { SettingsVideoTitles } from '@/components/settings/SettingsVideoTitles'
import { SettingsVideoFollows } from '@/components/settings/SettingsVideoFollows'
import { SettingsVideosQuality } from '@/components/settings/SettingsVideosQuality'
import { SettingsVideosPlexSync } from '@/components/settings/SettingsVideosPlexSync'
import { SettingsVideosPortability } from '@/components/videos/SettingsVideosPortability'
import { CompanionAbilitiesCard } from '@/components/shared/CompanionAbilitiesCard'
import { ToolConfigFields } from '@/components/shared/ToolConfigFields'
import { AdminYoutubeLimitsSection } from '@/components/admin/AdminYoutubeLimitsSection'

// Settings home for the Videos hub. ONE "Connect" section holds every source's connection
// (YouTube account sign-in, Reddit/Vimeo keys, TikTok note) so linking a source is never
// scattered. "Titles" is likewise hub-wide (Smart Titles applies to any caption-only source,
// currently TikTok). "Library" covers every source's offline/automation/Plex behavior
// (YouTube channels + generic follows, quality/enhance, Plex sync policies); the remaining
// sections are YouTube-specific under a "YouTube" heading; companion + admin sit under
// "General".
const SECTIONS: AppSettingsSection[] = [
  { id: 'connect',      label: 'Connect',             icon: Plug,        content: <SettingsVideoSources /> },
  { id: 'smart-titles', label: 'Titles',              icon: Type,        content: <SettingsVideoTitles /> },
  {
    id: 'channels', label: 'Channels', icon: Rss, group: 'Library',
    content: (
      <div className="space-y-8">
        <SettingsYoutubeChannels />
        <SettingsVideoFollows />
      </div>
    ),
  },
  {
    id: 'quality', label: 'Video quality', icon: Sparkles, group: 'Library',
    content: (
      <div className="space-y-8">
        <SettingsYoutubeVideoQuality />
        <SettingsVideosQuality />
      </div>
    ),
  },
  { id: 'plex-sync',    label: 'Plex sync',           icon: Server,      group: 'Library', content: <SettingsVideosPlexSync /> },
  { id: 'portability',  label: 'Import & export',     icon: ArrowLeftRight, group: 'Library', content: <SettingsVideosPortability /> },
  { id: 'auto-skip',    label: 'Auto-skip',           icon: SkipForward, group: 'YouTube', content: <SettingsYoutubeAutoSkip /> },
  { id: 'hidden',       label: 'Hidden content',      icon: EyeOff,      group: 'YouTube', content: <SettingsYoutubeHiddenContent /> },
  { id: 'titles',       label: 'Titles & thumbnails', icon: Wand2,       group: 'YouTube', content: <SettingsYoutubeTitlesThumbnails /> },
  { id: 'descriptions', label: 'Descriptions',        icon: FileText,    group: 'YouTube', content: <SettingsYoutubeDescriptions /> },
  { id: 'companion',    label: 'Companion',           icon: Bot,         group: 'General', content: <CompanionAbilitiesCard appId="youtube" /> },
  {
    id: 'admin', label: 'Admin', icon: ShieldCheck, adminOnly: true, group: 'General',
    content: (
      <div className="space-y-6">
        <ToolConfigFields toolId="youtube" />
        <AdminYoutubeLimitsSection />
      </div>
    ),
  },
]

export function VideosSettingsPage() {
  const { section: raw = 'connect' } = useParams<{ section?: string }>()
  // Old deep links (/settings/account for the YouTube sign-in, /settings/sources for the
  // per-source keys) both now live under Connect.
  const section = raw === 'account' || raw === 'sources' ? 'connect' : raw
  const navigate = useNavigate()
  const go = useCallback((id: string) => navigate(`/videos/settings/${id}`, { replace: true }), [navigate])

  return (
    <AppSettingsShell
      appId="youtube"
      icon={Play}
      gradient={getAppByPath('/videos')?.gradient}
      sections={SECTIONS}
      activeSection={section}
      onNavigate={go}
    />
  )
}
