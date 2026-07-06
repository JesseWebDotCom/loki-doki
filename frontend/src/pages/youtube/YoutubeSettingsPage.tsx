import { useCallback, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { SkipForward, Sparkles, Wand2, FileText, Menu, Rss } from 'lucide-react'
import type { PanelSection } from '@/components/shared/PanelLayout'
import { SettingsSidebar } from '@/components/settings/SettingsSidebar'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { PageHeader } from '@/components/shared/PageHeader'
import {
  SettingsYoutubeChannels, SettingsYoutubeAutoSkip, SettingsYoutubeVideoQuality,
  SettingsYoutubeTitlesThumbnails, SettingsYoutubeDescriptions,
} from '@/components/settings/SettingsYoutubeTab'

// Same left-column pattern as the main Settings page and Admin panel (SettingsPage.tsx) —
// requested directly: "the admin panel has a distinct left column for its settings, the
// user settings has a distinct left column, put that same column on YouTube settings."
const SECTIONS: PanelSection[] = [
  { id: 'channels',     label: 'Channels',             icon: Rss },
  { id: 'auto-skip',    label: 'Auto-skip',            icon: SkipForward },
  { id: 'quality',      label: 'Video quality',        icon: Sparkles },
  { id: 'titles',       label: 'Titles & thumbnails',  icon: Wand2 },
  { id: 'descriptions', label: 'Descriptions',         icon: FileText },
]

// Standard per-app Settings home for YouTube: channel management (subscriptions, auto-save,
// save quality, pause automation) plus the user-scoped viewing prefs (SponsorBlock / DeArrow /
// Smart Description). The Channels section surfaces the one admin control (default keep-N)
// inline when the viewer is an admin; broader app config still lives in central Admin → Apps.
export function YoutubeSettingsPage() {
  const { section = 'channels' } = useParams<{ section?: string }>()
  const navigate = useNavigate()
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('youtube.settingsSidebarCollapsed') === '1')
  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => { const next = !c; localStorage.setItem('youtube.settingsSidebarCollapsed', next ? '1' : '0'); return next })
  }, [])

  const go = useCallback((id: string) => {
    navigate(`/youtube/settings/${id}`, { replace: true })
    setMobileNavOpen(false)
  }, [navigate])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader
        title="Settings" className="px-4 pt-6 pb-5 sm:px-6 lg:px-8"
        actions={(
          <Button variant="ghost" size="icon-sm" onClick={() => setMobileNavOpen(true)} className="md:hidden" aria-label="Open navigation">
            <Menu className="size-5" />
          </Button>
        )}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <SettingsSidebar
          className="hidden md:flex"
          sections={SECTIONS} activeSection={section} onNavigate={go}
          collapsed={collapsed} onToggleCollapse={toggleCollapsed}
        />

        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetContent side="left" className="w-64 p-0">
            <SheetTitle className="sr-only">YouTube settings navigation</SheetTitle>
            <SettingsSidebar className="h-full w-full border-r-0" sections={SECTIONS} activeSection={section} onNavigate={go} />
          </SheetContent>
        </Sheet>

        <div className="min-w-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-6 lg:px-8">
          {section === 'channels'     && <SettingsYoutubeChannels />}
          {section === 'auto-skip'    && <SettingsYoutubeAutoSkip />}
          {section === 'quality'      && <SettingsYoutubeVideoQuality />}
          {section === 'titles'       && <SettingsYoutubeTitlesThumbnails />}
          {section === 'descriptions' && <SettingsYoutubeDescriptions />}
        </div>
      </div>
    </div>
  )
}
