import { useState, useEffect, lazy } from 'react'
import { Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { AuthProvider, useAuth } from '@/context/AuthContext'
import { ThemeProvider } from '@/context/ThemeContext'
import { AppToaster } from '@/components/shared/AppToaster'
import { UIContextProvider } from '@/context/UIContextProvider'
import { BreadcrumbSearchProvider } from '@/context/BreadcrumbSearchContext'
import { SpotlightProvider } from '@/components/shared/SpotlightSearch'
import { PlayerOverlayProvider } from '@/context/PlayerOverlayContext'
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
import { MonitoringAnnounceProvider } from '@/context/MonitoringAnnounceContext'
import { FamilyAudioGuard } from '@/components/shared/FamilyAudioGuard'
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
import { LocationOnboarding } from '@/components/onboarding/LocationOnboarding'
import { GuidedTour } from '@/components/onboarding/GuidedTour'
import { ProfilePickerPage } from '@/pages/ProfilePickerPage'
import { HomePage } from '@/pages/HomePage'
import { DisplayPage } from '@/pages/DisplayPage'
import { HudPage } from '@/pages/HudPage'
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
import { BookmarksHomePage } from '@/pages/bookmarks/BookmarksHomePage'
import { BookmarksTagsPage } from '@/pages/bookmarks/BookmarksTagsPage'
import { BookmarkReadPage } from '@/pages/bookmarks/BookmarkReadPage'
import { BookmarksSettingsPage } from '@/pages/bookmarks/BookmarksSettingsPage'
import { PublicCollectionPage } from '@/pages/bookmarks/PublicCollectionPage'
import { NewsReadPage } from '@/pages/news/NewsReadPage'
import { SavePage } from '@/pages/SavePage'
import { BoredPage } from '@/pages/BoredPage'
import { VideoPage } from '@/pages/VideoPage'
import { MedicalPage } from '@/pages/MedicalPage'

// Lazy-loaded: each of these pulls in a heavy leaf dependency (MapLibre/pmtiles, the full
// admin panel, image-gen UI, InnerTube/player, or the music engine) that most sessions
// never touch. Splitting them out of the main chunk means Home/Chat — what basically every
// session opens first — doesn't pay for code it won't run. See agents.md App Header
// Contract for why routes, not individual widgets, are the split boundary.
const MapsPage = lazy(() => import('@/pages/MapsPage').then((m) => ({ default: m.MapsPage })))
const MapsSettingsPage = lazy(() => import('@/pages/MapsSettingsPage').then((m) => ({ default: m.MapsSettingsPage })))
const ImagingPage = lazy(() => import('@/pages/ImagingPage').then((m) => ({ default: m.ImagingPage })))
const AdminPage = lazy(() => import('@/pages/AdminPage').then((m) => ({ default: m.AdminPage })))

// Non-first-open routes, split out of the entry chunk (Coding pulls xterm, Canvas pulls
// CodeMirror, and the podcast/store/companion-store/shows/movies groups are large but rarely
// the first page a session opens).
const HomeInventoryPage = lazy(() => import('@/pages/HomeInventoryPage').then((m) => ({ default: m.HomeInventoryPage })))
const NotesLayout = lazy(() => import('@/components/notes/NotesLayout').then((m) => ({ default: m.NotesLayout })))
const NotesListPage = lazy(() => import('@/pages/notes/NotesListPage').then((m) => ({ default: m.NotesListPage })))
const NoteEditorPage = lazy(() => import('@/pages/notes/NoteEditorPage').then((m) => ({ default: m.NoteEditorPage })))
const CompanionStoreLayout = lazy(() => import('@/components/companions/store/CompanionStoreLayout').then((m) => ({ default: m.CompanionStoreLayout })))
const CompanionHomePage = lazy(() => import('@/pages/companion-store/CompanionHomePage').then((m) => ({ default: m.CompanionHomePage })))
const CompanionBrowsePage = lazy(() => import('@/pages/companion-store/CompanionBrowsePage').then((m) => ({ default: m.CompanionBrowsePage })))
const CompanionCategoriesPage = lazy(() => import('@/pages/companion-store/CompanionCategoriesPage').then((m) => ({ default: m.CompanionCategoriesPage })))
const CompanionCategoryPage = lazy(() => import('@/pages/companion-store/CompanionCategoryPage').then((m) => ({ default: m.CompanionCategoryPage })))
const CompanionFavoritesPage = lazy(() => import('@/pages/companion-store/CompanionFavoritesPage').then((m) => ({ default: m.CompanionFavoritesPage })))
const CompanionDetailPage = lazy(() => import('@/pages/companion-store/CompanionDetailPage').then((m) => ({ default: m.CompanionDetailPage })))
const CompanionStudioPage = lazy(() => import('@/pages/companion-store/CompanionStudioPage').then((m) => ({ default: m.CompanionStudioPage })))
const DocsPage = lazy(() => import('@/pages/DocsPage').then((m) => ({ default: m.DocsPage })))
const NewsPage = lazy(() => import('@/pages/NewsPage').then((m) => ({ default: m.NewsPage })))
const OnThisDayPage = lazy(() => import('@/pages/OnThisDayPage').then((m) => ({ default: m.OnThisDayPage })))
const RecipesPage = lazy(() => import('@/pages/RecipesPage').then((m) => ({ default: m.RecipesPage })))
const MoviesRail = lazy(() => import('@/pages/movies/MoviesRailPages').then((m) => ({ default: m.MoviesInTheatersPage })))
const MoviesNewPage = lazy(() => import('@/pages/movies/MoviesRailPages').then((m) => ({ default: m.MoviesNewPage })))
const MoviesTopRatedPage = lazy(() => import('@/pages/movies/MoviesRailPages').then((m) => ({ default: m.MoviesTopRatedPage })))
const MoviesGenresPage = lazy(() => import('@/pages/movies/MoviesRailPages').then((m) => ({ default: m.MoviesGenresPage })))
const MoviesWatchlistPage = lazy(() => import('@/pages/movies/MoviesRailPages').then((m) => ({ default: m.MoviesWatchlistPage })))
const MoviesFamilyPage = lazy(() => import('@/pages/movies/MoviesRailPages').then((m) => ({ default: m.MoviesFamilyPage })))
const ShowsOnTvPage = lazy(() => import('@/pages/shows/ShowsRailPages').then((m) => ({ default: m.ShowsOnTvPage })))
const ShowsCalendarPage = lazy(() => import('@/pages/shows/ShowsRailPages').then((m) => ({ default: m.ShowsCalendarPage })))
const ShowsTopRatedPage = lazy(() => import('@/pages/shows/ShowsRailPages').then((m) => ({ default: m.ShowsTopRatedPage })))
const ShowsGenresPage = lazy(() => import('@/pages/shows/ShowsRailPages').then((m) => ({ default: m.ShowsGenresPage })))
const ShowsContinuePage = lazy(() => import('@/pages/shows/ShowsRailPages').then((m) => ({ default: m.ShowsContinuePage })))
const ShowsWatchlistPage = lazy(() => import('@/pages/shows/ShowsRailPages').then((m) => ({ default: m.ShowsWatchlistPage })))
const ShowsFamilyPage = lazy(() => import('@/pages/shows/ShowsRailPages').then((m) => ({ default: m.ShowsFamilyPage })))
const SkillsPage = lazy(() => import('@/pages/SkillsPage').then((m) => ({ default: m.SkillsPage })))
const VoiceMemosPage = lazy(() => import('@/pages/VoiceMemosPage').then((m) => ({ default: m.VoiceMemosPage })))
const JokePage = lazy(() => import('@/pages/JokePage').then((m) => ({ default: m.JokePage })))
const UnitConverterPage = lazy(() => import('@/pages/UnitConverterPage').then((m) => ({ default: m.UnitConverterPage })))
const SpeedTestPage = lazy(() => import('@/pages/SpeedTestPage').then((m) => ({ default: m.SpeedTestPage })))
const ShoppingPage = lazy(() => import('@/pages/shopping/ShoppingPage').then((m) => ({ default: m.ShoppingPage })))
const ProductDetailPage = lazy(() => import('@/pages/shopping/ProductDetailPage').then((m) => ({ default: m.ProductDetailPage })))
const CodingPage = lazy(() => import('@/pages/coding/CodingPage').then((m) => ({ default: m.CodingPage })))
const RemoteLayout = lazy(() => import('@/pages/remote/RemoteLayout').then((m) => ({ default: m.RemoteLayout })))
const CamerasPage = lazy(() => import('@/pages/CamerasPage').then((m) => ({ default: m.CamerasPage })))
const ReverseLookupPage = lazy(() => import('@/pages/ReverseLookupPage').then((m) => ({ default: m.ReverseLookupPage })))
const ConverterPage = lazy(() => import('@/pages/ConverterPage').then((m) => ({ default: m.ConverterPage })))
const DropPage = lazy(() => import('@/pages/DropPage').then((m) => ({ default: m.DropPage })))
const ClipperPage = lazy(() => import('@/pages/ClipperPage').then((m) => ({ default: m.ClipperPage })))
const CanvasPage = lazy(() => import('@/pages/CanvasPage').then((m) => ({ default: m.CanvasPage })))
const PodcastLayout = lazy(() => import('@/components/podcast/PodcastLayout').then((m) => ({ default: m.PodcastLayout })))
const ListenNowPage = lazy(() => import('@/pages/podcast/ListenNowPage').then((m) => ({ default: m.ListenNowPage })))
const PodcastBrowsePage = lazy(() => import('@/pages/podcast/PodcastBrowsePage').then((m) => ({ default: m.PodcastBrowsePage })))
const PodcastPreviewPage = lazy(() => import('@/pages/podcast/PodcastPreviewPage').then((m) => ({ default: m.PodcastPreviewPage })))
const PodcastLibraryPage = lazy(() => import('@/pages/podcast/PodcastLibraryPage').then((m) => ({ default: m.PodcastLibraryPage })))
const PodcastOfflinePage = lazy(() => import('@/pages/podcast/PodcastOfflinePage').then((m) => ({ default: m.PodcastOfflinePage })))
const PodcastFiltersPage = lazy(() => import('@/pages/podcast/PodcastFiltersPage').then((m) => ({ default: m.PodcastFiltersPage })))
const PodcastBookmarksPage = lazy(() => import('@/pages/podcast/PodcastBookmarksPage').then((m) => ({ default: m.PodcastBookmarksPage })))
const PodcastReplayPage = lazy(() => import('@/pages/podcast/PodcastReplayPage').then((m) => ({ default: m.PodcastReplayPage })))
const ShowDetailPage = lazy(() => import('@/pages/podcast/ShowDetailPage').then((m) => ({ default: m.ShowDetailPage })))
const PodcastSettingsPage = lazy(() => import('@/pages/podcast/PodcastSettingsPage').then((m) => ({ default: m.PodcastSettingsPage })))
const DictionaryPage = lazy(() => import('@/pages/DictionaryPage').then((m) => ({ default: m.DictionaryPage })))
const MediaLayout = lazy(() => import('@/components/media/MediaLayout').then((m) => ({ default: m.MediaLayout })))
const ShowsHomePage = lazy(() => import('@/pages/shows/ShowsHomePage').then((m) => ({ default: m.ShowsHomePage })))
const ShowsDetailPage = lazy(() => import('@/pages/shows/ShowDetailPage').then((m) => ({ default: m.ShowDetailPage })))
const MoviesHomePage = lazy(() => import('@/pages/movies/MoviesHomePage').then((m) => ({ default: m.MoviesHomePage })))
const MovieDetailPage = lazy(() => import('@/pages/movies/MovieDetailPage').then((m) => ({ default: m.MovieDetailPage })))
const MoviesSettingsPage = lazy(() => import('@/pages/movies/MoviesSettingsPage').then((m) => ({ default: m.MoviesSettingsPage })))
const WhereToWatchPage = lazy(() => import('@/pages/WhereToWatchPage').then((m) => ({ default: m.WhereToWatchPage })))
const ReferencePage = lazy(() => import('@/pages/reference/ReferencePage').then((m) => ({ default: m.ReferencePage })))
const SportsPage = lazy(() => import('@/pages/SportsPage').then((m) => ({ default: m.SportsPage })))
const HolidaysPage = lazy(() => import('@/pages/HolidaysPage').then((m) => ({ default: m.HolidaysPage })))
const MoonPhasePage = lazy(() => import('@/pages/MoonPhasePage').then((m) => ({ default: m.MoonPhasePage })))
const HomeAssistantPage = lazy(() => import('@/pages/HomeAssistantPage').then((m) => ({ default: m.HomeAssistantPage })))
const HomeAssistantSettingsPage = lazy(() => import('@/pages/HomeAssistantSettingsPage').then((m) => ({ default: m.HomeAssistantSettingsPage })))
const LocalEventsPage = lazy(() => import('@/pages/LocalEventsPage').then((m) => ({ default: m.LocalEventsPage })))
const StoreLayout = lazy(() => import('@/components/store/StoreLayout').then((m) => ({ default: m.StoreLayout })))
const StoreHomePage = lazy(() => import('@/pages/store/StoreHomePage').then((m) => ({ default: m.StoreHomePage })))
const StoreBrowsePage = lazy(() => import('@/pages/store/StoreBrowsePage').then((m) => ({ default: m.StoreBrowsePage })))
const StoreCategoriesPage = lazy(() => import('@/pages/store/StoreCategoriesPage').then((m) => ({ default: m.StoreCategoriesPage })))
const StoreCategoryPage = lazy(() => import('@/pages/store/StoreCategoryPage').then((m) => ({ default: m.StoreCategoryPage })))
const StoreAppDetailPage = lazy(() => import('@/pages/store/StoreAppDetailPage').then((m) => ({ default: m.StoreAppDetailPage })))
const StoreInstalledPage = lazy(() => import('@/pages/store/StoreInstalledPage').then((m) => ({ default: m.StoreInstalledPage })))

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
const MusicReplayPage = lazy(() => import('@/pages/music/MusicReplayPage').then((m) => ({ default: m.MusicReplayPage })))
const MusicStatsPage = lazy(() => import('@/pages/music/MusicStatsPage').then((m) => ({ default: m.MusicStatsPage })))
const MusicImportPage = lazy(() => import('@/pages/music/MusicImportPage').then((m) => ({ default: m.MusicImportPage })))
const MusicPlaylistPage = lazy(() => import('@/pages/music/MusicPlaylistPage').then((m) => ({ default: m.MusicPlaylistPage })))
const MusicGeneratePage = lazy(() => import('@/pages/music/MusicCreatePages').then((m) => ({ default: m.MusicGeneratePage })))
const MusicRemixPage = lazy(() => import('@/pages/music/MusicCreatePages').then((m) => ({ default: m.MusicRemixPage })))
const MusicStudioPage = lazy(() => import('@/pages/music/MusicStudioPage').then((m) => ({ default: m.MusicStudioPage })))
const KaraokePage = lazy(() => import('@/pages/music/KaraokePage').then((m) => ({ default: m.KaraokePage })))
const MusicStudioLayout = lazy(() => import('@/pages/music/MusicStudioLayout').then((m) => ({ default: m.MusicStudioLayout })))
const MusicStudioDetailPage = lazy(() => import('@/pages/music/MusicStudioDetailPage').then((m) => ({ default: m.MusicStudioDetailPage })))
const MusicStudioTabPage = lazy(() => import('@/pages/music/MusicStudioTabPage').then((m) => ({ default: m.MusicStudioTabPage })))
const MusicStudioTutorialsPage = lazy(() => import('@/pages/music/MusicStudioTutorialsPage').then((m) => ({ default: m.MusicStudioTutorialsPage })))

const BooksLayout = lazy(() => import('@/components/books/BooksLayout').then((m) => ({ default: m.BooksLayout })))
const BooksLibraryPage = lazy(() => import('@/pages/books/BooksLibraryPage').then((m) => ({ default: m.BooksLibraryPage })))
const BookShelfPage = lazy(() => import('@/pages/books/BookShelfPage').then((m) => ({ default: m.BookShelfPage })))
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
const VideosSearchPage = lazy(() => import('@/pages/videos/VideosSearchPage').then((m) => ({ default: m.VideosSearchPage })))
const RedditBrowsePage = lazy(() => import('@/pages/videos/RedditBrowsePage').then((m) => ({ default: m.RedditBrowsePage })))
const VideosOfflinePage = lazy(() => import('@/pages/videos/VideosOfflinePage').then((m) => ({ default: m.VideosOfflinePage })))
const TikTokBrowsePage = lazy(() => import('@/pages/videos/TikTokBrowsePage').then((m) => ({ default: m.TikTokBrowsePage })))
const VimeoBrowsePage = lazy(() => import('@/pages/videos/VimeoBrowsePage').then((m) => ({ default: m.VimeoBrowsePage })))
const MyVideosPage = lazy(() => import('@/pages/videos/create/MyVideosPage').then((m) => ({ default: m.MyVideosPage })))
const StudioEditorPage = lazy(() => import('@/pages/videos/create/StudioEditorPage').then((m) => ({ default: m.StudioEditorPage })))
const SourceCreatorPage = lazy(() => import('@/pages/videos/SourceCreatorPage').then((m) => ({ default: m.SourceCreatorPage })))
const SourcePlaylistPage = lazy(() => import('@/pages/videos/SourcePlaylistPage').then((m) => ({ default: m.SourcePlaylistPage })))
const LegacyYoutubeRedirect = lazy(() => import('@/components/videos/LegacyYoutubeRedirect').then((m) => ({ default: m.LegacyYoutubeRedirect })))
const YoutubeHomePage = lazy(() => import('@/pages/youtube/YoutubeHomePage').then((m) => ({ default: m.YoutubeHomePage })))
const YoutubeHistoryPage = lazy(() => import('@/pages/youtube/YoutubeLibraryPage').then((m) => ({ default: m.YoutubeHistoryPage })))
const YoutubePlaylistsPage = lazy(() => import('@/pages/youtube/YoutubeLibraryPage').then((m) => ({ default: m.YoutubePlaylistsPage })))
const YoutubeWatchLaterPage = lazy(() => import('@/pages/youtube/YoutubeLibraryPage').then((m) => ({ default: m.YoutubeWatchLaterPage })))
const YoutubeLikedPage = lazy(() => import('@/pages/youtube/YoutubeLibraryPage').then((m) => ({ default: m.YoutubeLikedPage })))
const YoutubeChannelPage = lazy(() => import('@/pages/youtube/YoutubeChannelPage').then((m) => ({ default: m.YoutubeChannelPage })))
const YoutubeSubscriptionsPage = lazy(() => import('@/pages/youtube/YoutubeSubscriptionsPage').then((m) => ({ default: m.YoutubeSubscriptionsPage })))
const VideosSubscriptionsPage = lazy(() => import('@/pages/videos/VideosSubscriptionsPage').then((m) => ({ default: m.VideosSubscriptionsPage })))
const YoutubeShortsPage = lazy(() => import('@/pages/youtube/YoutubeShortsPage').then((m) => ({ default: m.YoutubeShortsPage })))
const YoutubePlaylistPage = lazy(() => import('@/pages/youtube/YoutubePlaylistPage').then((m) => ({ default: m.YoutubePlaylistPage })))
const YoutubeMyPlaylistPage = lazy(() => import('@/pages/youtube/YoutubeMyPlaylistPage').then((m) => ({ default: m.YoutubeMyPlaylistPage })))
const WatchPage = lazy(() => import('@/pages/videos/WatchPage').then((m) => ({ default: m.WatchPage })))
const VideosSettingsPage = lazy(() => import('@/pages/videos/VideosSettingsPage').then((m) => ({ default: m.VideosSettingsPage })))

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

  // One-time per account: capture the user's location (ZIP/city) so weather, clock, local news,
  // briefing, and movie showtimes personalize automatically. Renders <Outlet/> once set/skipped.
  return <LocationOnboarding />
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
  if (pathname === '/save' || pathname === '/login' || pathname === '/setup' || pathname === '/hud') return null
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
          <SpotlightProvider>
          <PlayerOverlayProvider>
          <GenerationProvider>
          <PrivacyProvider>
          <PodcastPlaybackProvider>
          <YoutubePlaybackProvider>
          <RadioProvider>
          <LiveRadioProvider>
          <TimeAlarmProvider>
          <FrigateAnnounceProvider>
          <MonitoringAnnounceProvider>
          <ChatProvider>
          {/* Family audio guardrails: graceful stop, 5-minute warning, volume cap. */}
          <FamilyAudioGuard />
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
                <Route path="/maps/settings/:section?" element={<MapsSettingsPage />} />
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
                  <Route path="replay" element={<MusicReplayPage />} />
                  <Route path="stats" element={<MusicStatsPage />} />
                  <Route path="import" element={<MusicImportPage />} />
                  <Route path="studio" element={<MusicStudioPage />} />
                  <Route path="studio/:id" element={<MusicStudioLayout />}>
                    <Route index element={<MusicStudioDetailPage />} />
                    <Route path="tab" element={<MusicStudioTabPage />} />
                    <Route path="tutorials" element={<MusicStudioTutorialsPage />} />
                  </Route>
                  <Route path="karaoke" element={<KaraokePage />} />
                  <Route path="playlist/:id" element={<MusicPlaylistPage />} />
                </Route>
                <Route path="/books" element={<BooksLayout />}>
                  <Route index element={<BooksDiscoverPage />} />
                  <Route path="magazines" element={<MagazinesPage />} />
                  <Route path="library" element={<BooksLibraryPage />} />
                  <Route path="shelf/:id" element={<BookShelfPage />} />
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
                {/* Retired standalone Video app: generation now lives in the hub's Create area. */}
                <Route path="/video" element={<Navigate to="/videos/create" replace />} />
                <Route path="/read/:sourceId" element={<ReaderPage />} />
                <Route path="/categories" element={<CategoriesPage />} />
                <Route path="/category/:category" element={<CategoryPage />} />
                <Route path="/bookmarks" element={<BookmarksLayout />}>
                  <Route index element={<BookmarksHomePage />} />
                  <Route path="all" element={<BookmarksLibraryPage />} />
                  <Route path="collection/:id" element={<BookmarksLibraryPage />} />
                  <Route path="tags" element={<BookmarksTagsPage />} />
                  <Route path="read/:id" element={<BookmarkReadPage />} />
                  <Route path="settings" element={<BookmarksSettingsPage />} />
                </Route>
                <Route path="/notes" element={<NotesLayout />}>
                  <Route index element={<NotesListPage />} />
                  <Route path=":id" element={<NoteEditorPage />} />
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
                  <Route path="search" element={<VideosSearchPage />} />
                  {/* Cross-source library (YouTube-only until more providers land). */}
                  <Route path="subscriptions" element={<VideosSubscriptionsPage />} />
                  <Route path="history" element={<YoutubeHistoryPage />} />
                  <Route path="playlists" element={<YoutubePlaylistsPage />} />
                  <Route path="watch-later" element={<YoutubeWatchLaterPage />} />
                  <Route path="liked" element={<YoutubeLikedPage />} />
                  <Route path="offline" element={<VideosOfflinePage />} />
                  <Route path="clip" element={<ClipperPage />} />
                  {/* Mine: your videos + the studio and AI generation (former /video app). */}
                  <Route path="mine" element={<MyVideosPage />} />
                  <Route path="mine/generate" element={<VideoPage />} />
                  <Route path="mine/:projectId" element={<StudioEditorPage />} />
                  <Route path="create" element={<Navigate to="/videos/mine" replace />} />
                  <Route path="create/generate" element={<Navigate to="/videos/mine/generate" replace />} />
                  <Route path="create/:projectId" element={<StudioEditorPage />} />
                  <Route path="settings/:section?" element={<VideosSettingsPage />} />
                  {/* Reddit source area. */}
                  <Route path="reddit" element={<RedditBrowsePage />} />
                  <Route path="reddit/r/:id" element={<SourceCreatorPage source="reddit" />} />
                  {/* TikTok source area. */}
                  <Route path="tiktok" element={<TikTokBrowsePage />} />
                  <Route path="tiktok/creator/:id" element={<SourceCreatorPage source="tiktok" />} />
                  <Route path="tiktok/playlist/:id" element={<SourcePlaylistPage source="tiktok" />} />
                  {/* Vimeo source area. */}
                  <Route path="vimeo" element={<VimeoBrowsePage />} />
                  <Route path="vimeo/channel/:id" element={<SourceCreatorPage source="vimeo" />} />
                  {/* One watch page for every source (including YouTube) — see WatchPage.tsx. */}
                  <Route path=":source/watch/:id" element={<WatchPage />} />
                  {/* YouTube source area: the retired standalone app lives on here. */}
                  <Route path="youtube" element={<YoutubeHomePage />} />
                  <Route path="youtube/subscriptions" element={<YoutubeSubscriptionsPage />} />
                  <Route path="youtube/channel/:id" element={<YoutubeChannelPage />} />
                  <Route path="youtube/playlist/:id" element={<YoutubePlaylistPage />} />
                  <Route path="youtube/my-playlist/:id" element={<YoutubeMyPlaylistPage />} />
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
                  <Route path="filters" element={<PodcastFiltersPage />} />
                  <Route path="bookmarks" element={<PodcastBookmarksPage />} />
                  <Route path="replay" element={<PodcastReplayPage />} />
                  <Route path="offline" element={<PodcastOfflinePage />} />
                  <Route path="show/:id" element={<ShowDetailPage />} />
                  <Route path="settings" element={<PodcastSettingsPage />} />
                  <Route path="admin" element={<Navigate to="/podcasts/settings" replace />} />
                </Route>
                <Route path="/home-inventory" element={<HomeInventoryPage />} />
                <Route path="/news" element={<NewsPage />} />
                <Route path="/news/read/:id" element={<NewsReadPage />} />
                <Route path="/news/reader" element={<NewsReadPage />} />
                <Route path="/on-this-day" element={<OnThisDayPage />} />
                <Route path="/moon-phase" element={<MoonPhasePage />} />
                <Route path="/recipes" element={<RecipesPage />} />
                {/* The standalone Showtimes app folded into Movies → In Theaters. */}
                <Route path="/showtimes" element={<Navigate to="/movies/in-theaters" replace />} />
                <Route path="/skills" element={<SkillsPage />} />
                <Route path="/voice-memos" element={<VoiceMemosPage />} />
                <Route path="/jokes" element={<JokePage />} />
                <Route path="/unit-converter" element={<UnitConverterPage />} />
                <Route path="/speed-test" element={<SpeedTestPage />} />
                <Route path="/shopping" element={<ShoppingPage />} />
                <Route path="/shopping/product/:retailer/:encodedId" element={<ProductDetailPage />} />
                <Route path="/coding" element={<CodingPage />} />
                <Route path="/remote" element={<RemoteLayout />} />
                <Route path="/cameras" element={<CamerasPage />} />
                <Route path="/reverse-lookup" element={<ReverseLookupPage />} />
                <Route path="/converter" element={<ConverterPage />} />
                <Route path="/drop" element={<DropPage />} />
                <Route path="/clipper" element={<Navigate to="/videos/clip" replace />} />
                <Route path="/canvas" element={<CanvasPage />} />
                <Route path="/time" element={<TimePage />} />
                {/* Dictionary + Medical are now sections of the Reference app. */}
                <Route path="/dictionary" element={<Navigate to="/reference/dictionary" replace />} />
                {/* Movies + Shows share the always-dark MediaLayout cinema shell. */}
                <Route element={<MediaLayout />}>
                  <Route path="/shows" element={<ShowsHomePage />} />
                  <Route path="/shows/on-tv" element={<ShowsOnTvPage />} />
                  <Route path="/shows/calendar" element={<ShowsCalendarPage />} />
                  <Route path="/shows/top-rated" element={<ShowsTopRatedPage />} />
                  <Route path="/shows/genres" element={<ShowsGenresPage />} />
                  <Route path="/shows/family" element={<ShowsFamilyPage />} />
                  <Route path="/shows/continue" element={<ShowsContinuePage />} />
                  <Route path="/shows/watchlist" element={<ShowsWatchlistPage />} />
                  <Route path="/shows/:id" element={<ShowsDetailPage />} />
                  <Route path="/movies" element={<MoviesHomePage />} />
                  <Route path="/movies/settings" element={<MoviesSettingsPage />} />
                  <Route path="/movies/in-theaters" element={<MoviesRail />} />
                  <Route path="/movies/new" element={<MoviesNewPage />} />
                  <Route path="/movies/top-rated" element={<MoviesTopRatedPage />} />
                  <Route path="/movies/genres" element={<MoviesGenresPage />} />
                  <Route path="/movies/family" element={<MoviesFamilyPage />} />
                  <Route path="/movies/watchlist" element={<MoviesWatchlistPage />} />
                  <Route path="/movies/:ref" element={<MovieDetailPage />} />
                </Route>
                {/* Renamed from "TV Shows" — keep old links working. */}
                <Route path="/tv-shows" element={<Navigate to="/shows" replace />} />
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

            {/* Desktop shell HUD, a transparent always-on-top Electron window. Unguarded:
                the page handles the signed-out state itself with a tiny hand-off pill
                (a <Navigate> to /login would render the full profile picker in a 480px
                transparent overlay). */}
            <Route path="/hud" element={<HudPage />} />

            {/* Public shared bookmark collection: no auth, read-only view by slug. */}
            <Route path="/b/:slug" element={<PublicCollectionPage />} />

            {/* Catch-all */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </ChatProvider>
          </MonitoringAnnounceProvider>
          </FrigateAnnounceProvider>
          <AlarmRingDialog />
          <GlobalSetupWidget />
          <GuidedTour />
          <RestorePrompt />
          </TimeAlarmProvider>
          </LiveRadioProvider>
          </RadioProvider>
          </YoutubePlaybackProvider>
          </PodcastPlaybackProvider>
          <PrivacyOverlay />
          </PrivacyProvider>
          </GenerationProvider>
          </PlayerOverlayProvider>
          </SpotlightProvider>
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
