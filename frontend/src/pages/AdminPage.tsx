import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom'
import { PanelLeft, Search, WifiOff } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { Button } from '@/components/ui/button'
import { findSection, findSubsection, defaultSub, LEGACY_ADMIN_REDIRECTS } from '@/components/admin/adminRegistry'
import { AdminSidebar } from '@/components/admin/AdminSidebar'
import { AdminOverview } from '@/components/admin/AdminOverview'
import { AdminCommandPalette } from '@/components/admin/AdminCommandPalette'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { AdminAccordion } from '@/components/admin/AdminAccordion'
import { AdminFeaturesTab } from '@/components/admin/AdminFeaturesTab'
import { AdminAppsTab, DefaultHomeLayoutSection, PerUserHomeLayoutSection } from '@/components/admin/AdminAppsTab'
import { AdminUsersTab } from '@/components/admin/AdminUsersTab'
import { AdminSystemTab } from '@/components/admin/AdminSystemTab'
import { AdminAiEngineTab } from '@/components/admin/AdminAiEngineTab'
import { AdminAdvancedTab, type AdvancedView } from '@/components/admin/AdminAdvancedTab'
import { AdminCompanionsTab, type CompanionView } from '@/components/admin/AdminCompanionsTab'
import { AdminSecurityTab } from '@/components/admin/AdminSecurityTab'
import { AdminNotificationsTab } from '@/components/admin/AdminNotificationsTab'
import { AdminFrigateTab } from '@/components/admin/AdminFrigateTab'
import { AdminIntegrationsOverview } from '@/components/admin/AdminIntegrationsOverview'
import { AdminMonitoringTab } from '@/components/admin/AdminMonitoringTab'
import { AdminDevicesTab } from '@/components/admin/AdminDevicesTab'
import { AdminLocaleTab } from '@/components/admin/AdminLocaleTab'
import { AdminRemoteEngineTab } from '@/components/admin/AdminRemoteEngineTab'
import { AdminPlexTab } from '@/components/admin/AdminPlexTab'
import { AdminHomeAssistantTab } from '@/components/admin/AdminHomeAssistantTab'
import { AdminBooksTab } from '@/components/admin/AdminBooksTab'
import { AdminMediaServiceTab, type MediaService } from '@/components/admin/AdminDownloadsTab'
import { UninstallPanel } from '@/components/admin/UninstallPanel'
import { ServerPanel } from '@/components/admin/ServerPanel'
import { AdminStorageTab } from '@/components/admin/AdminStorageTab'
import { AdminStorageLocationsTab } from '@/components/admin/AdminStorageLocationsTab'

const DOWNLOAD_SECTIONS = new Set(['features', 'companions', 'advanced'])

export function AdminPage() {
  const { section: rawSection = 'overview', subsection: rawSub } = useParams<{ section?: string; subsection?: string }>()
  const navigate = useNavigate()
  const location = useLocation()

  // Relocated URLs redirect (rendered below, after every hook has run, to keep the
  // hook order stable across the redirecting and normal render paths).
  const legacyTarget = LEGACY_ADMIN_REDIRECTS[`${rawSection}/${rawSub ?? ''}`] ?? LEGACY_ADMIN_REDIRECTS[rawSection]

  const section = findSection(rawSection) ? rawSection : 'overview'
  const sub = findSubsection(section, rawSub)?.id ?? defaultSub(section)

  const sectionDef = findSection(section)
  const subDef = findSubsection(section, sub)
  usePublishUIContext({
    label: 'Admin',
    description: `User is in the Admin panel${sectionDef ? `, "${sectionDef.label}"` : ''}${subDef ? ` › ${subDef.label}` : ''} section.`,
  })

  const [query, setQuery] = useState('')
  const [navNonce, setNavNonce] = useState(0)
  const [spySub, setSpySub] = useState<string | undefined>(undefined)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('admin.sidebarCollapsed') === '1')
  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => { const next = !c; localStorage.setItem('admin.sidebarCollapsed', next ? '1' : '0'); return next })
  }, [])
  const contentRef = useRef<HTMLDivElement>(null)
  const [globallyOffline, setGloballyOffline] = useState(false)
  const [downloadsAllowed, setDownloadsAllowed] = useState(false)

  useEffect(() => {
    fetch('/api/admin/connectivity', { credentials: 'include' })
      .then(r => r.ok ? r.json() as Promise<{ globalMode: string; allowDownloads: boolean }> : null)
      .then(d => { if (d) { setGloballyOffline(d.globalMode === 'offline'); setDownloadsAllowed(d.allowDownloads) } })
      .catch(() => {})
  }, [])

  // ⌘K / Ctrl+K opens the command palette anywhere in the admin panel.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const go = useCallback((sectionId: string, subId?: string) => {
    const target = subId ?? defaultSub(sectionId)
    navigate(`/admin/${sectionId}${target ? `/${target}` : ''}`)
    setNavNonce(n => n + 1)  // bump so re-selecting the same item re-triggers expand
    setQuery('')
    setMobileNavOpen(false)
  }, [navigate])

  // Token handed to anchor tabs so they can expand the matching right-side item.
  const openSignal = `${sub ?? ''}#${navNonce}`

  // Publish the live section/subsection into the ONE global breadcrumb (Home > Admin >
  // System > Connectivity) instead of a second local header bar; the mobile-nav trigger
  // and ⌘K search affordance ride along as slots on the same bar.
  useAppHeader({
    query: '', setQuery: () => {}, searchable: false,
    leftSlot: (
      // Labeled (not a bare hamburger): an unlabeled Menu glyph here was identical to
      // other menu icons while opening a completely different drawer.
      <Button variant="ghost" size="sm" onClick={() => setMobileNavOpen(true)} className="md:hidden gap-1.5" aria-label="Open admin sections">
        <PanelLeft className="size-4" />
        Sections
      </Button>
    ),
    rightSlot: (
      <Button variant="outline" size="sm" onClick={() => setPaletteOpen(true)} className="gap-1.5 text-xs text-muted-foreground">
        <Search className="size-3.5" />
        <span className="hidden sm:inline">Search</span>
        <kbd className="hidden rounded border border-border/60 bg-muted px-1 font-sans text-[10px] sm:inline">⌘K</kbd>
      </Button>
    ),
    extraCrumbs: [
      { label: sectionDef?.label ?? 'Admin', onClick: subDef ? () => go(section) : undefined },
      ...(subDef ? [{ label: subDef.label }] : []),
    ],
  })

  // Deep-link scroll: when navigating to an anchor subsection, scroll to it and flash.
  useEffect(() => {
    if (subDef?.kind !== 'anchor' || !subDef.anchorId) return
    const id = subDef.anchorId
    const t = setTimeout(() => {
      const el = document.getElementById(id)
      if (!el) return
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      el.classList.add('admin-flash')
      setTimeout(() => el.classList.remove('admin-flash'), 1600)
    }, 80)
    return () => clearTimeout(t)
  }, [section, sub, subDef])

  // Scroll-spy: as the right pane scrolls, highlight the section in view on the left.
  useEffect(() => {
    setSpySub(undefined)
    const sec = findSection(section)
    const root = contentRef.current
    if (!sec || sec.subsections.length === 0 || !root) return
    let obs: IntersectionObserver | null = null
    const raf = requestAnimationFrame(() => {
      const idToSub = new Map<string, string>()
      const els: HTMLElement[] = []
      for (const s of sec.subsections) {
        const el = document.getElementById(s.anchorId ?? s.id)
        if (el) { idToSub.set(el.id, s.id); els.push(el) }
      }
      if (els.length === 0) return
      const visible = new Set<string>()
      obs = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id); else visible.delete(e.target.id)
        }
        const top = els.find(el => visible.has(el.id))
        if (top) setSpySub(idToSub.get(top.id))
      }, { root, rootMargin: '0px 0px -65% 0px', threshold: 0 })
      els.forEach(el => obs!.observe(el))
    })
    return () => { cancelAnimationFrame(raf); obs?.disconnect() }
  }, [section, sub])

  if (legacyTarget) return <Navigate to={legacyTarget + location.search} replace />

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Desktop sidebar (collapsible icon rail) */}
      <AdminSidebar
        className="hidden md:flex"
        sectionId={section} subId={spySub ?? sub} query={query} setQuery={setQuery} onNavigate={go}
        collapsed={collapsed} onToggleCollapse={toggleCollapsed}
      />

      {/* Mobile nav drawer */}
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-64 p-0">
          <SheetTitle className="sr-only">Admin navigation</SheetTitle>
          <AdminSidebar
            className="h-full w-full border-r-0"
            sectionId={section} subId={spySub ?? sub} query={query} setQuery={setQuery} onNavigate={go}
          />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
      <div ref={contentRef} className="flex-1 overflow-y-auto">
        {(subDef?.description ?? sectionDef?.description) && (
          <p className="px-5 pt-4 text-sm text-muted-foreground">{subDef?.description ?? sectionDef?.description}</p>
        )}
        {globallyOffline && DOWNLOAD_SECTIONS.has(section) && (
          <div className="mx-6 mt-4 flex items-start gap-3 rounded-control border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
            <WifiOff className="mt-0.5 size-4 shrink-0" />
            <span>
              {downloadsAllowed
                ? 'Global offline mode is active: users cannot access internet features, but admin downloads are still allowed.'
                : 'Global offline mode is active: downloads and external installs are disabled. Go to '}
              {!downloadsAllowed && <strong>System</strong>}
              {!downloadsAllowed && ' to enable downloads or switch back online.'}
            </span>
          </div>
        )}

        {section === 'overview' && <AdminOverview onNavigate={go} />}
        {section === 'system' && (
          <div className="space-y-3 p-5">
            <AdminAccordion id="connectivity" title="Connectivity"
              description="Online/offline mode and download permissions."
              openSignal={openSignal} defaultOpen contentClassName="p-0">
              <AdminSystemTab />
            </AdminAccordion>
            <AdminAccordion id="locale" title="Locale & Units"
              description="Measurement units, temperature, currency, and time format."
              openSignal={openSignal} defaultOpen={false} contentClassName="p-0">
              <AdminLocaleTab />
            </AdminAccordion>
            <AdminAccordion id="server" title="Updates & Restart"
              description="Version info, updates, and restarting the server."
              openSignal={openSignal} defaultOpen={false} contentClassName="p-0">
              <ServerPanel />
            </AdminAccordion>
            <AdminAccordion id="uninstall" title="Uninstall"
              description="Remove the app and wipe its data."
              openSignal={openSignal} defaultOpen={false} contentClassName="p-0">
              <UninstallPanel />
            </AdminAccordion>
          </div>
        )}
        {section === 'features'   && <AdminFeaturesTab view={sub} />}
        {section === 'apps'       && <AdminAppsTab openSignal={openSignal} />}
        {section === 'companions' && <AdminCompanionsTab view={(sub as CompanionView) ?? 'voice'} />}
        {section === 'notifications' && <AdminNotificationsTab openSignal={openSignal} />}
        {section === 'devices'    && <AdminDevicesTab view={sub} />}
        {section === 'integrations' && sub === 'overview'        && <AdminIntegrationsOverview onNavigate={go} />}
        {section === 'integrations' && sub === 'frigate'         && <AdminFrigateTab />}
        {section === 'integrations' && sub === 'monitoring'       && <AdminMonitoringTab />}
        {section === 'integrations' && sub === 'plex'            && <AdminPlexTab />}
        {section === 'integrations' && sub === 'home-assistant'  && <AdminHomeAssistantTab />}
        {section === 'integrations' && sub === 'books'           && <AdminBooksTab />}
        {section === 'integrations' && ['sonarr', 'radarr', 'overseerr', 'sabnzbd'].includes(sub ?? '') && <AdminMediaServiceTab service={sub as MediaService} />}
        {section === 'security'   && <AdminSecurityTab view={sub} />}
        {section === 'users'      && <AdminUsersTab openSignal={openSignal} />}
        {section === 'advanced'   && <AdminAdvancedTab view={(sub as AdvancedView) ?? 'diagnostics'} />}
        {section === 'ai-engine' && sub === 'runtime' && (
          <div className="p-5"><AdminAiEngineTab /></div>
        )}
        {section === 'ai-engine' && sub === 'remote' && <AdminRemoteEngineTab />}
        {section === 'storage' && sub === 'usage' && (
          <div className="p-5"><AdminStorageTab /></div>
        )}
        {section === 'storage' && sub === 'locations' && (
          <div className="p-5"><AdminStorageLocationsTab /></div>
        )}
      </div>
      </div>

      <AdminCommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onNavigate={go} />
    </div>
  )
}
