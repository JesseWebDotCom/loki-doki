import { useState, useEffect, lazy, Suspense } from 'react'
import { Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { AuthProvider, useAuth } from '@/context/AuthContext'
import { ThemeProvider } from '@/context/ThemeContext'
import { AppToaster } from '@/components/shared/AppToaster'
import { UIContextProvider } from '@/context/UIContextProvider'
import { BreadcrumbSearchProvider } from '@/context/BreadcrumbSearchContext'
import { ChatProvider } from '@/context/ChatContext'
import { GenerationProvider } from '@/context/GenerationContext'
import { PrivacyProvider } from '@/context/PrivacyContext'
import { ServerHealthProvider } from '@/context/ServerHealthContext'
import { SetupProgressProvider } from '@/context/SetupProgressContext'
import { GpuHealthProvider } from '@/context/GpuHealthContext'
import { PodcastPlaybackProvider } from '@/context/PodcastPlaybackContext'
import { YoutubePlaybackProvider } from '@/context/YoutubePlaybackContext'
import { RadioProvider } from '@/context/RadioContext'
import { LiveRadioProvider } from '@/context/LiveRadioContext'
import { TimeAlarmProvider } from '@/context/TimeAlarmContext'
import { FrigateAnnounceProvider } from '@/context/FrigateAnnounceContext'
import { AlarmRingDialog } from '@/components/time/AlarmRingDialog'
import { PrivacyOverlay } from '@/components/shared/PrivacyOverlay'
import { ServerHealthBanner } from '@/components/shared/ServerHealthBanner'
import { BackgroundSetupWidget } from '@/components/shared/BackgroundSetupWidget'
import { RestorePrompt } from '@/components/shared/RestorePrompt'
import { Spinner } from '@/components/ui/spinner'
import { AppShell } from '@/components/shell/AppShell'
import { BootScreen } from '@/components/shell/BootScreen'
import { SetupWizard } from '@/pages/SetupWizard'
import { WelcomeWizard } from '@/pages/WelcomeWizard'
import { ProfilePickerPage } from '@/pages/ProfilePickerPage'
import { HomePage } from '@/pages/HomePage'
import { DisplayPage } from '@/pages/DisplayPage'
import { WeatherPage } from '@/pages/WeatherPage'
import { WeatherSettingsPage } from '@/pages/WeatherSettingsPage'
import { AppSettingsGenericPage } from '@/pages/AppSettingsGenericPage'
import { TimePage } from '@/pages/TimePage'
import { ChatLayout } from '@/components/chat/ChatLayout'
import { ConversationView } from '@/components/chat/ConversationView'
import { ProjectPage } from '@/components/chat/ProjectPage'
import { ChatsBrowsePage } from '@/components/chat/ChatsBrowsePage'
import { ProjectsBrowsePage } from '@/components/chat/ProjectsBrowsePage'
import { SettingsPage } from '@/pages/SettingsPage'
import { ReaderPage } from '@/pages/ReaderPage'
import { CategoryPage } from '@/pages/CategoryPage'
import { CategoriesPage } from '@/pages/CategoriesPage'
import { BookmarksLayout } from '@/components/bookmarks/BookmarksLayout'
import { BookmarksLibraryPage } from '@/pages/bookmarks/BookmarksLibraryPage'
import { BookmarkReadPage } from '@/pages/bookmarks/BookmarkReadPage'
import { BookmarksSettingsPage } from '@/pages/bookmarks/BookmarksSettingsPage'
import { NewsReadPage } from '@/pages/news/NewsReadPage'
import { SavePage } from '@/pages/SavePage'
import { BoredPage } from '@/pages/BoredPage'
import { VideoPage } from '@/pages/VideoPage'
import { HomeInventoryPage } from '@/pages/HomeInventoryPage'
import { CompanionStoreLayout } from '@/components/companions/store/CompanionStoreLayout'
import { CompanionHomePage } from '@/pages/companion-store/CompanionHomePage'
import { CompanionBrowsePage } from '@/pages/companion-store/CompanionBrowsePage'
import { CompanionCategoriesPage } from '@/pages/companion-store/CompanionCategoriesPage'
import { CompanionCategoryPage } from '@/pages/companion-store/CompanionCategoryPage'
import { CompanionFavoritesPage } from '@/pages/companion-store/CompanionFavoritesPage'
import { CompanionDetailPage } from '@/pages/companion-store/CompanionDetailPage'
import { CompanionStudioPage } from '@/pages/companion-store/CompanionStudioPage'
import { DocsPage } from '@/pages/DocsPage'
import { NewsPage } from '@/pages/NewsPage'
import { OnThisDayPage } from '@/pages/OnThisDayPage'
import { RecipesPage } from '@/pages/RecipesPage'
import { ShowtimesPage } from '@/pages/ShowtimesPage'
import { SkillsPage } from '@/pages/SkillsPage'
import { VoiceMemosPage } from '@/pages/VoiceMemosPage'
import { JokePage } from '@/pages/JokePage'
import { UnitConverterPage } from '@/pages/UnitConverterPage'
import { SpeedTestPage } from '@/pages/SpeedTestPage'
import { ShoppingPage } from '@/pages/shopping/ShoppingPage'
import { ProductDetailPage } from '@/pages/shopping/ProductDetailPage'
import { CodingPage } from '@/pages/coding/CodingPage'
import { CamerasPage } from '@/pages/CamerasPage'
import { ReverseLookupPage } from '@/pages/ReverseLookupPage'
import { ConverterPage } from '@/pages/ConverterPage'
import { DropPage } from '@/pages/DropPage'
import { ClipperPage } from '@/pages/ClipperPage'
import { CanvasPage } from '@/pages/CanvasPage'
import { PodcastLayout } from '@/components/podcast/PodcastLayout'
import { ListenNowPage } from '@/pages/podcast/ListenNowPage'
import { PodcastBrowsePage } from '@/pages/podcast/PodcastBrowsePage'
import { PodcastPreviewPage } from '@/pages/podcast/PodcastPreviewPage'
import { PodcastLibraryPage } from '@/pages/podcast/PodcastLibraryPage'
import { PodcastOfflinePage } from '@/pages/podcast/PodcastOfflinePage'
import { ShowDetailPage } from '@/pages/podcast/ShowDetailPage'
import { PodcastSettingsPage } from '@/pages/podcast/PodcastSettingsPage'
import { DictionaryPage } from '@/pages/DictionaryPage'
import { ShowsHomePage } from '@/pages/shows/ShowsHomePage'
import { ShowDetailPage as ShowsDetailPage } from '@/pages/shows/ShowDetailPage'
import { MoviesHomePage } from '@/pages/movies/MoviesHomePage'
import { MovieDetailPage } from '@/pages/movies/MovieDetailPage'
import { MoviesSettingsPage } from '@/pages/movies/MoviesSettingsPage'
import { WhereToWatchPage } from '@/pages/WhereToWatchPage'
import { MedicalPage } from '@/pages/MedicalPage'
import { ReferencePage } from '@/pages/reference/ReferencePage'
import { SportsPage } from '@/pages/SportsPage'
import { HolidaysPage } from '@/pages/HolidaysPage'
import { MoonPhasePage } from '@/pages/MoonPhasePage'
import { HomeAssistantPage } from '@/pages/HomeAssistantPage'
import { HomeAssistantSettingsPage } from '@/pages/HomeAssistantSettingsPage'
import { LocalEventsPage } from '@/pages/LocalEventsPage'
import { StoreLayout } from '@/components/store/StoreLayout'
import { StoreHomePage } from '@/pages/store/StoreHomePage'
import { StoreBrowsePage } from '@/pages/store/StoreBrowsePage'
import { StoreCategoriesPage } from '@/pages/store/StoreCategoriesPage'
import { StoreCategoryPage } from '@/pages/store/StoreCategoryPage'
import { StoreAppDetailPage } from '@/pages/store/StoreAppDetailPage'
import { StoreInstalledPage } from '@/pages/store/StoreInstalledPage'

// Lazy-loaded: each of these pulls in a heavy leaf dependency (MapLibre/pmtiles, the full
// admin panel, image-gen UI, InnerTube/player, or the music engine) that most sessions
// never touch. Splitting them out of the main chunk means Home/Chat — what basically every
// session opens first — doesn't pay for code it won't run. See agents.md App Header
// Contract for why routes, not individual widgets, are the split boundary.
const MapsPage = lazy(() => import('@/pages/MapsPage').then((m) => ({ default: m.MapsPage })))
const ImagingPage = lazy(() => import('@/pages/ImagingPage').then((m) => ({ default: m.ImagingPage })))
const AdminPage = lazy(() => import('@/pages/AdminPage').then((m) => ({ default: m.AdminPage })))

const MusicLayout = lazy(() => import('@/components/music/MusicLayout').then((m) => ({ default: m.MusicLayout })))
const MusicHomePage = lazy(() => import('@/pages/music/MusicHomePage').then((m) => ({ default: m.MusicHomePage })))
const MusicStationsPage = lazy(() => import('@/pages/music/MusicStationsPage').then((m) => ({ default: m.MusicStationsPage })))
const MusicStationPage = lazy(() => import('@/pages/music/MusicStationPage').then((m) => ({ default: m.MusicStationPage })))
const MusicWatchStationPage = lazy(() => import('@/pages/music/MusicWatchStationPage').then((m) => ({ default: m.MusicWatchStationPage })))
const MusicBrowsePage = lazy(() => import('@/pages/music/MusicBrowsePage').then((m) => ({ default: m.MusicBrowsePage })))
const MusicLiveRadioPage = lazy(() => import('@/pages/music/MusicLiveRadioPage').then((m) => ({ default: m.MusicLiveRadioPage })))
const NowPlayingPage = lazy(() => import('@/pages/music/NowPlayingPage').then((m) => ({ default: m.NowPlayingPage })))
const MusicArtistPage = lazy(() => import('@/pages/music/MusicArtistPage').then((m) => ({ default: m.MusicArtistPage })))
const MusicAlbumPage = lazy(() => import('@/pages/music/MusicAlbumPage').then((m) => ({ default: m.MusicAlbumPage })))
const MusicLibraryPage = lazy(() => import('@/pages/music/MusicLibraryPage').then((m) => ({ default: m.MusicLibraryPage })))
const MusicPlaylistPage = lazy(() => import('@/pages/music/MusicPlaylistPage').then((m) => ({ default: m.MusicPlaylistPage })))
const MusicGeneratePage = lazy(() => import('@/pages/music/MusicCreatePages').then((m) => ({ default: m.MusicGeneratePage })))
const MusicRemixPage = lazy(() => import('@/pages/music/MusicCreatePages').then((m) => ({ default: m.MusicRemixPage })))

const BooksLayout = lazy(() => import('@/components/books/BooksLayout').then((m) => ({ default: m.BooksLayout })))
const BooksLibraryPage = lazy(() => import('@/pages/books/BooksLibraryPage').then((m) => ({ default: m.BooksLibraryPage })))
const BooksDiscoverPage = lazy(() => import('@/pages/books/BooksDiscoverPage').then((m) => ({ default: m.BooksDiscoverPage })))
const MagazinesPage = lazy(() => import('@/pages/books/MagazinesPage').then((m) => ({ default: m.MagazinesPage })))
const BooksUploadPage = lazy(() => import('@/pages/books/BooksUploadPage').then((m) => ({ default: m.BooksUploadPage })))
const BookReaderPage = lazy(() => import('@/pages/books/BookReaderPage').then((m) => ({ default: m.BookReaderPage })))
const AudiobookPlayerPage = lazy(() => import('@/pages/books/AudiobookPlayerPage').then((m) => ({ default: m.AudiobookPlayerPage })))
const BookDetailPage = lazy(() => import('@/pages/books/BookDetailPage').then((m) => ({ default: m.BookDetailPage })))
const BooksAudiobooksPage = lazy(() => import('@/pages/books/BooksAudiobooksPage').then((m) => ({ default: m.BooksAudiobooksPage })))
const ArchiveBrowsePage = lazy(() => import('@/pages/books/ArchiveBrowsePage').then((m) => ({ default: m.ArchiveBrowsePage })))
const BookPreviewPage = lazy(() => import('@/pages/books/BookPreviewPage').then((m) => ({ default: m.BookPreviewPage })))
const BookCategoryPage = lazy(() => import('@/pages/books/BookCategoryPage').then((m) => ({ default: m.BookCategoryPage })))
const BooksSourcesPage = lazy(() => import('@/pages/books/BooksSourcesPage').then((m) => ({ default: m.BooksSourcesPage })))
const BookCreateEntryPage = lazy(() => import('@/pages/books/generate/BookCreateEntryPage').then((m) => ({ default: m.BookCreateEntryPage })))
const BookCreateBriefPage = lazy(() => import('@/pages/books/generate/BookCreateBriefPage').then((m) => ({ default: m.BookCreateBriefPage })))
const BookBibleReviewPage = lazy(() => import('@/pages/books/generate/BookBibleReviewPage').then((m) => ({ default: m.BookBibleReviewPage })))
const BookSampleApprovalPage = lazy(() => import('@/pages/books/generate/BookSampleApprovalPage').then((m) => ({ default: m.BookSampleApprovalPage })))
const BookGenerationProgressPage = lazy(() => import('@/pages/books/generate/BookGenerationProgressPage').then((m) => ({ default: m.BookGenerationProgressPage })))

const VideosLayout = lazy(() => import('@/components/videos/VideosLayout').then((m) => ({ default: m.VideosLayout })))
const VideosHomePage = lazy(() => import('@/pages/videos/VideosHomePage').then((m) => ({ default: m.VideosHomePage })))
const LegacyYoutubeRedirect = lazy(() => import('@/components/videos/LegacyYoutubeRedirect').then((m) => ({ default: m.LegacyYoutubeRedirect })))
const YoutubeHomePage = lazy(() => import('@/pages/youtube/YoutubeHomePage').then((m) => ({ default: m.YoutubeHomePage })))
const YoutubeHistoryPage = lazy(() => import('@/pages/youtube/YoutubeLibraryPage').then((m) => ({ default: m.YoutubeHistoryPage })))
const YoutubePlaylistsPage = lazy(() => import('@/pages/youtube/YoutubeLibraryPage').then((m) => ({ default: m.YoutubePlaylistsPage })))
const YoutubeWatchLaterPage = lazy(() => import('@/pages/youtube/YoutubeLibraryPage').then((m) => ({ default: m.YoutubeWatchLaterPage })))
const YoutubeLikedPage = lazy(() => import('@/pages/youtube/YoutubeLibraryPage').then((m) => ({ default: m.YoutubeLikedPage })))
const YoutubeOfflinePage = lazy(() => import('@/pages/youtube/YoutubeLibraryPage').then((m) => ({ default: m.YoutubeOfflinePage })))
const YoutubeChannelPage = lazy(() => import('@/pages/youtube/YoutubeChannelPage').then((m) => ({ default: m.YoutubeChannelPage })))
const YoutubeSubscriptionsPage = lazy(() => import('@/pages/youtube/YoutubeSubscriptionsPage').then((m) => ({ default: m.YoutubeSubscriptionsPage })))
const YoutubeShortsPage = lazy(() => import('@/pages/youtube/YoutubeShortsPage').then((m) => ({ default: m.YoutubeShortsPage })))
const YoutubePlaylistPage = lazy(() => import('@/pages/youtube/YoutubePlaylistPage').then((m) => ({ default: m.YoutubePlaylistPage })))
const YoutubeMyPlaylistPage = lazy(() => import('@/pages/youtube/YoutubeMyPlaylistPage').then((m) => ({ default: m.YoutubeMyPlaylistPage })))
const WatchPage = lazy(() => import('@/pages/youtube/WatchPage').then((m) => ({ default: m.WatchPage })))
const YoutubeSettingsPage = lazy(() => import('@/pages/youtube/YoutubeSettingsPage').then((m) => ({ default: m.YoutubeSettingsPage })))

function AppLoading() {
  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <Spinner size="lg" className="size-8" />
    </div>
  )
}

function Placeholder({ label }: { label: string }) {
  return (
    <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
      {label} — coming soon
    </div>
  )
}

// Legacy /feeds/read/:id → /news/read/:id (Feeds merged into News), preserving the article id.
function FeedRedirect() {
  const { id = '' } = useParams()
  return <Navigate to={`/news/read/${id}`} replace />
}

// ── Setup guard ───────────────────────────────────────────────────────────────
// Wraps /setup. Stays in wizard until firstRunComplete.
// Once complete + authenticated, redirect to app; if complete but not logged in, send to /login.
function SetupGuard() {
  const { user, configured, firstRunComplete, loading } = useAuth()

  if (loading) return <AppLoading />

  // If first run is complete and user is authenticated → into the app
  if (configured && firstRunComplete && user) return <Navigate to="/" replace />

  // If first run is complete but no session → login page
  if (configured && firstRunComplete && !user) return <Navigate to="/login" replace />

  // Not configured, or configured but first run not complete: show wizard
  // If admin already exists (configured=true, firstRunComplete=false), skip profile step
  if (configured && !firstRunComplete) {
    return <SetupWizard startStep={user ? 'models' : 'profile'} />
  }

  // Fresh install (not configured at all)
  return <SetupWizard startStep="profile" />
}

// ── Login guard ───────────────────────────────────────────────────────────────
// Wraps /login. Redirects to setup if first run not complete.
function LoginGuard() {
  const { user, configured, firstRunComplete, loading } = useAuth()
  const { pathname } = useLocation()

  if (loading) return <AppLoading />

  // Not set up at all, or setup incomplete → back to wizard
  if (!configured || !firstRunComplete) return <Navigate to="/setup" replace />

  // Already logged in → app
  if (user && pathname === '/login') return <Navigate to="/" replace />

  return <Outlet />
}

// ── Admin guard ───────────────────────────────────────────────────────────────
function AdminGuard() {
  const { user, loading } = useAuth()
  if (loading) return <AppLoading />
  if (!user) return <Navigate to="/login" replace />
  if (user.role !== 'admin') return <Navigate to="/" replace />
  return <Outlet />
}

// ── Auth guard ────────────────────────────────────────────────────────────────
// Wraps all protected app routes. Requires setup complete + authenticated.
function AuthGuard() {
  const { user, configured, firstRunComplete, welcomeComplete, loading, refetch } = useAuth()
  // null = checking, false = show boot screen, true = already booted
  const [booted, setBooted] = useState<boolean | null>(null)

  useEffect(() => {
    fetch('/api/system/ready', { credentials: 'include' })
      .then((r) => setBooted(r.ok))
      .catch(() => setBooted(false))
  }, [])

  if (loading || booted === null) return <AppLoading />

  if (!configured || !firstRunComplete) return <Navigate to="/setup" replace />
  if (!user) return <Navigate to="/login" replace />

  if (!booted) {
    return <BootScreen onComplete={() => setBooted(true)} />
  }

  // First boot only: the admin picks offline content (library, maps, OCR), which then
  // downloads in the background. Shown once; refetch flips welcomeComplete → into the app.
  if (user.role === 'admin' && welcomeComplete === false) {
    return <WelcomeWizard onComplete={() => { void refetch() }} />
  }

  return <Outlet />
}

// Lightweight guard for the bookmarklet/share capture popup. Needs a session, but must NOT
// go through the boot screen or welcome wizard — it's a tiny chrome-less "save this" surface.
function SaveGuard() {
  const { user, configured, firstRunComplete, loading } = useAuth()
  if (loading) return <AppLoading />
  if (!configured || !firstRunComplete) return <Navigate to="/setup" replace />
  if (!user) return <Navigate to="/login" replace />
  return <Outlet />
}

// The global background-setup widget shouldn't intrude on chrome-less surfaces (the capture
// popup, login, setup) — only show it inside the actual app.
function GlobalSetupWidget() {
  const { pathname } = useLocation()
  if (pathname === '/save' || pathname === '/login' || pathname === '/setup') return null
  return <BackgroundSetupWidget />
}

export default function App() {
  return (
    <ServerHealthProvider>
    <SetupProgressProvider>
    <AuthProvider>
      <GpuHealthProvider>
      <ThemeProvider>
        <UIContextProvider>
          <BreadcrumbSearchProvider>
          <GenerationProvider>
          <PrivacyProvider>
          <PodcastPlaybackProvider>
          <YoutubePlaybackProvider>
          <RadioProvider>
          <LiveRadioProvider>
          <TimeAlarmProvider>
          <FrigateAnnounceProvider>
          <ChatProvider>
          <Suspense fallback={<AppLoading />}>
          <Routes>
            {/* Setup wizard — its own guard handles all setup state */}
            <Route path="/setup" element={<SetupGuard />} />

            {/* Profile picker — requires setup complete */}
            <Route element={<LoginGuard />}>
              <Route path="/login" element={<ProfilePickerPage />} />
            </Route>

            {/* Protected app routes — boot screen on first entry */}
            <Route element={<AuthGuard />}>
              <Route element={<AppShell />}>
                <Route path="/" element={<HomePage />} />
                <Route path="/chat" element={<ChatLayout />}>
                  <Route index element={<ConversationView />} />
                  <Route path="projects" element={<ProjectsBrowsePage />} />
                  <Route path="project/:projectId" element={<ProjectPage />} />
                  <Route path="chats" element={<ChatsBrowsePage />} />
                  <Route path=":id" element={<ConversationView />} />
                </Route>
                <Route path="/apps/:appId/settings/:section?" element={<AppSettingsGenericPage />} />
                <Route path="/maps" element={<MapsPage />} />
                <Route path="/weather" element={<WeatherPage />} />
                <Route path="/weather/settings" element={<WeatherSettingsPage />} />
                <Route path="/imaging" element={<ImagingPage />} />
                <Route path="/music" element={<MusicLayout />}>
                  <Route index element={<MusicHomePage />} />
                  <Route path="stations" element={<MusicStationsPage />} />
                  <Route path="station/:id" element={<MusicStationPage />} />
                  <Route path="watch/:id" element={<MusicWatchStationPage />} />
                  <Route path="browse" element={<MusicBrowsePage />} />
                  <Route path="live" element={<MusicLiveRadioPage />} />
                  <Route path="now-playing" element={<NowPlayingPage />} />
                  <Route path="artist/:mbid" element={<MusicArtistPage />} />
                  <Route path="album/:mbid" element={<MusicAlbumPage />} />
                  <Route path="generate" element={<MusicGeneratePage />} />
                  <Route path="remix" element={<MusicRemixPage />} />
                  <Route path="library" element={<MusicLibraryPage />} />
                  <Route path="playlist/:id" element={<MusicPlaylistPage />} />
                </Route>
                <Route path="/books" element={<BooksLayout />}>
                  <Route index element={<BooksDiscoverPage />} />
                  <Route path="magazines" element={<MagazinesPage />} />
                  <Route path="library" element={<BooksLibraryPage />} />
                  <Route path="audiobooks" element={<BooksAudiobooksPage />} />
                  <Route path="archives/:sourceId" element={<ArchiveBrowsePage />} />
                  <Route path="upload" element={<BooksUploadPage />} />
                  <Route path="detail/:id" element={<BookDetailPage />} />
                  <Route path="preview/:kind/:ref" element={<BookPreviewPage />} />
                  <Route path="category/:kind/:key" element={<BookCategoryPage />} />
                  <Route path="sources" element={<BooksSourcesPage />} />
                  <Route path="read/:id" element={<BookReaderPage />} />
                  <Route path="listen/:id" element={<AudiobookPlayerPage />} />
                  <Route path="generate" element={<BookCreateEntryPage />} />
                  <Route path="generate/new" element={<BookCreateBriefPage />} />
                  <Route path="generate/:id/bible" element={<BookBibleReviewPage />} />
                  <Route path="generate/:id/sample" element={<BookSampleApprovalPage />} />
                  <Route path="generate/:id/progress" element={<BookGenerationProgressPage />} />
                </Route>
                <Route path="/video" element={<VideoPage />} />
                <Route path="/read/:sourceId" element={<ReaderPage />} />
                <Route path="/categories" element={<CategoriesPage />} />
                <Route path="/category/:category" element={<CategoryPage />} />
                <Route path="/bookmarks" element={<BookmarksLayout />}>
                  <Route index element={<BookmarksLibraryPage />} />
                  <Route path="collection/:id" element={<BookmarksLibraryPage />} />
                  <Route path="read/:id" element={<BookmarkReadPage />} />
                  <Route path="settings" element={<BookmarksSettingsPage />} />
                </Route>
                {/* Backward-compat redirects: the app was renamed Reader/Links → Bookmarks. */}
                <Route path="/reader/*" element={<Navigate to="/bookmarks" replace />} />
                <Route path="/links/*" element={<Navigate to="/bookmarks" replace />} />
                {/* Feeds merged into News: bare /feeds → News; the article reader lives at /news/read/:id. */}
                <Route path="/feeds" element={<Navigate to="/news" replace />} />
                <Route path="/feeds/read/:id" element={<FeedRedirect />} />
                <Route path="/companions" element={<CompanionStoreLayout />}>
                  <Route index element={<CompanionHomePage />} />
                  <Route path="browse" element={<CompanionBrowsePage />} />
                  <Route path="categories" element={<CompanionCategoriesPage />} />
                  <Route path="category/:key" element={<CompanionCategoryPage />} />
                  <Route path="favorites" element={<CompanionFavoritesPage />} />
                  <Route path="c/:id" element={<CompanionDetailPage />} />
                  <Route path="studio" element={<CompanionStudioPage />} />
                </Route>
                <Route path="/bored" element={<BoredPage />} />
                <Route path="/videos" element={<VideosLayout />}>
                  <Route index element={<VideosHomePage />} />
                  {/* Cross-source library (YouTube-only until more providers land). */}
                  <Route path="history" element={<YoutubeHistoryPage />} />
                  <Route path="playlists" element={<YoutubePlaylistsPage />} />
                  <Route path="watch-later" element={<YoutubeWatchLaterPage />} />
                  <Route path="liked" element={<YoutubeLikedPage />} />
                  <Route path="offline" element={<YoutubeOfflinePage />} />
                  <Route path="clip" element={<ClipperPage />} />
                  <Route path="settings/:section?" element={<YoutubeSettingsPage />} />
                  {/* YouTube source area: the retired standalone app lives on here. */}
                  <Route path="youtube" element={<YoutubeHomePage />} />
                  <Route path="youtube/subscriptions" element={<YoutubeSubscriptionsPage />} />
                  <Route path="youtube/channel/:id" element={<YoutubeChannelPage />} />
                  <Route path="youtube/playlist/:id" element={<YoutubePlaylistPage />} />
                  <Route path="youtube/my-playlist/:id" element={<YoutubeMyPlaylistPage />} />
                  <Route path="youtube/watch/:videoId" element={<WatchPage />} />
                  <Route path="youtube/shorts/:videoId" element={<YoutubeShortsPage />} />
                </Route>
                {/* Retired /youtube app: permanent redirects into the Videos hub. */}
                <Route path="/youtube/*" element={<LegacyYoutubeRedirect />} />
                <Route path="/youtube" element={<LegacyYoutubeRedirect />} />
                <Route path="/podcasts" element={<PodcastLayout />}>
                  <Route index element={<ListenNowPage />} />
                  <Route path="browse" element={<PodcastBrowsePage />} />
                  <Route path="preview" element={<PodcastPreviewPage />} />
                  <Route path="library" element={<PodcastLibraryPage />} />
                  <Route path="offline" element={<PodcastOfflinePage />} />
                  <Route path="show/:id" element={<ShowDetailPage />} />
                  <Route path="settings" element={<PodcastSettingsPage />} />
                  <Route path="admin" element={<Navigate to="/podcasts/settings" replace />} />
                </Route>
                <Route path="/home-inventory" element={<HomeInventoryPage />} />
                <Route path="/news" element={<NewsPage />} />
                <Route path="/news/read/:id" element={<NewsReadPage />} />
                <Route path="/on-this-day" element={<OnThisDayPage />} />
                <Route path="/moon-phase" element={<MoonPhasePage />} />
                <Route path="/recipes" element={<RecipesPage />} />
                <Route path="/showtimes" element={<ShowtimesPage />} />
                <Route path="/skills" element={<SkillsPage />} />
                <Route path="/voice-memos" element={<VoiceMemosPage />} />
                <Route path="/jokes" element={<JokePage />} />
                <Route path="/unit-converter" element={<UnitConverterPage />} />
                <Route path="/speed-test" element={<SpeedTestPage />} />
                <Route path="/shopping" element={<ShoppingPage />} />
                <Route path="/shopping/product/:retailer/:encodedId" element={<ProductDetailPage />} />
                <Route path="/coding" element={<CodingPage />} />
                <Route path="/cameras" element={<CamerasPage />} />
                <Route path="/reverse-lookup" element={<ReverseLookupPage />} />
                <Route path="/converter" element={<ConverterPage />} />
                <Route path="/drop" element={<DropPage />} />
                <Route path="/clipper" element={<Navigate to="/videos/clip" replace />} />
                <Route path="/canvas" element={<CanvasPage />} />
                <Route path="/time" element={<TimePage />} />
                {/* Dictionary + Medical are now sections of the Reference app. */}
                <Route path="/dictionary" element={<Navigate to="/reference/dictionary" replace />} />
                <Route path="/shows" element={<ShowsHomePage />} />
                <Route path="/shows/:id" element={<ShowsDetailPage />} />
                {/* Renamed from "TV Shows" — keep old links working. */}
                <Route path="/tv-shows" element={<Navigate to="/shows" replace />} />
                <Route path="/movies" element={<MoviesHomePage />} />
                <Route path="/movies/settings" element={<MoviesSettingsPage />} />
                <Route path="/movies/:ref" element={<MovieDetailPage />} />
                <Route path="/where-to-watch" element={<WhereToWatchPage />} />
                <Route path="/medical" element={<Navigate to="/reference/medical" replace />} />
                <Route path="/reference" element={<ReferencePage />} />
                <Route path="/reference/medical" element={<MedicalPage />} />
                <Route path="/reference/dictionary" element={<DictionaryPage />} />
                <Route path="/sports" element={<SportsPage />} />
                <Route path="/holidays" element={<HolidaysPage />} />
                <Route path="/home-assistant" element={<HomeAssistantPage />} />
                <Route path="/home-assistant/settings" element={<HomeAssistantSettingsPage />} />
                <Route path="/local-events" element={<LocalEventsPage />} />
                <Route path="/app-store" element={<StoreLayout />}>
                  <Route index element={<StoreHomePage />} />
                  <Route path="browse" element={<StoreBrowsePage />} />
                  <Route path="categories" element={<StoreCategoriesPage />} />
                  <Route path="category/:key" element={<StoreCategoryPage />} />
                  <Route path="installed" element={<StoreInstalledPage />} />
                  <Route path="app/:appId" element={<StoreAppDetailPage />} />
                </Route>
                <Route path="/docs/user" element={<DocsPage entry="user" />} />
                <Route path="/docs/dev"  element={<DocsPage entry="dev"  />} />
                <Route path="/me" element={<Placeholder label="Profile" />} />
                <Route path="/settings/:section?" element={<SettingsPage />} />
              </Route>

              {/* Admin-only routes */}
              <Route element={<AdminGuard />}>
                <Route element={<AppShell />}>
                  <Route path="/admin/:section?/:subsection?" element={<AdminPage />} />
                </Route>
              </Route>
            </Route>

            {/* Capture popup (bookmarklet / share target) — authenticated but chrome-less:
                no boot screen, no welcome wizard, no setup widget. */}
            <Route element={<SaveGuard />}>
              <Route path="/save" element={<SavePage />} />
              {/* Ambient device display — same chrome-less, auth-only guard so a screen
                  Pod's render shows the clock/weather straight away (no boot/welcome UI). */}
              <Route path="/display" element={<DisplayPage />} />
            </Route>

            {/* Catch-all */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </Suspense>
          </ChatProvider>
          </FrigateAnnounceProvider>
          <AlarmRingDialog />
          <GlobalSetupWidget />
          <RestorePrompt />
          </TimeAlarmProvider>
          </LiveRadioProvider>
          </RadioProvider>
          </YoutubePlaybackProvider>
          </PodcastPlaybackProvider>
          <PrivacyOverlay />
          </PrivacyProvider>
          </GenerationProvider>
          </BreadcrumbSearchProvider>
        </UIContextProvider>
        <AppToaster />
      </ThemeProvider>
      </GpuHealthProvider>
      <ServerHealthBanner />
    </AuthProvider>
    </SetupProgressProvider>
    </ServerHealthProvider>
  )
}
