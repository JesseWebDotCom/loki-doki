# "Shows" + "Movies" — entertainment apps redesign

Two sibling apps sharing a keyless core:
- **Shows** (renamed from "TV Shows", route `/shows`) — rich TV discovery + tracking + per-episode AI podcasts.
- **Movies** (new, route `/movies`) — same richness for film + local showtimes (reuses the existing Showtimes app) + single deep-dive AI podcast.

Both include **reviews**, **Common Sense Media parents guide**, **wallpaper backdrops**, **trivia/did-you-know**, **where-to-stream**, **trailers/music**, and **Plex** availability.

## Decisions (locked)
- **Keyless data only.** TVMaze + JustWatch + Wikipedia + YouTube (InnerTube) + SearXNG images + Fandango (existing showtimes).
- **Personal tracking.** Unified watchlist (shows + movies) + watched-episode progress.
- **Shows podcasts:** one episode per TV episode, generated in **batches of 5** + "Generate next batch" (existing podcast queue + cap pattern).
- **Movies podcasts:** one deep-dive discussion/review episode per film (franchises may batch one per film).
- **Showtimes:** reuse existing **Movie Showtimes** app (`tools/showtimes.ts` `fetchShowtimes(zip,date)`, Fandango, keyless).
- **Plex:** optional per-user integration (server URL + X-Plex-Token), Home-Assistant-style; graceful when unset.
- **Names:** "Shows" and "Movies".

## Keyless data sources (all already in repo)
| Need | Source | Where |
| --- | --- | --- |
| TV details, episodes (synopses), cast, **background art**, external IDs (imdb/tvdb) | TVMaze | `tools/tvshows.ts` (extend) |
| Movie metadata, trending/popular/new, where-to-stream, scores, external IDs | JustWatch | `tools/whereToWatch.ts` |
| Local showtimes | Fandango | `tools/showtimes.ts` `fetchShowtimes()` |
| Overview, reviews/reception, trivia, per-episode articles | Wikipedia | `lib/wikipediaSearch.ts` |
| Trailers, clips, theme song, soundtrack, interviews | YouTube InnerTube | `lib/youtube/innertube.ts` |
| Extra images / wallpaper candidates | SearXNG images (`categories=images`) | `lib/searxng.ts` |
| Review snippets / aggregate scores | web search + JustWatch scores | `lib/webSearch.ts` |
| Age rating + parents-need-to-know + per-category severity | Common Sense Media | `lib/briefing/sources/commonSense.ts` `commonSenseRating()` |
| Caching | `cachedLookup(ns,key,ttl,fetcher)` | `lib/lookupCache.ts` |
| Image proxy/cache | generalize YT `imageCache.ts` | new `lib/imageProxy.ts` + `/api/media/img` |

## Shared backend core: `lib/titles/`
Used by both Shows and Movies:
- `backdrop.ts` — wallpaper picker: TVMaze background art / JustWatch backdrop → SearXNG image search → blurred poster fallback.
- `media.ts` — YouTube trailer / clips / `"<title> theme song"` / soundtrack → playable links (deep-link to in-app YouTube watch page).
- `reviews.ts` — aggregate scores (JustWatch: IMDb/TMDB/RT where present) + Wikipedia "Reception" + web-search critic snippets → LLM-distilled summary + score badges. (videoBrief.ts pattern.)
- `trivia.ts` — Wikipedia (Trivia/Production/Reception) + web search → LLM "Did you know?" bullets. Cached.
- `parentsGuide.ts` — thin wrapper over `commonSenseRating()` → age badge + "parents need to know" + per-category severity dots; cached; ties into the content-policy system.
- `imageProxy.ts` — generic allowlisted read-through disk cache (tvmaze, justwatch, wikimedia, fandango), generalized from `imageCache.ts`.

## Plex: `lib/plex/`
- Config (server URL + `X-Plex-Token`), per-user, Home-Assistant-style; `isPlexConfigured(userId)`.
- `findInPlex({type,title,year,imdbId?,tvdbId?})` — query library, match by external GUID first then title+year → `{ present, ratingKey, deepLink }`.
- `addToPlexWatchlist(item)` via plex.tv Discover API.
- `listPlexRecent()` for an optional "From your Plex" home shelf.
- All graceful no-ops when unconfigured.

## Shows: `lib/shows/` + `routes/shows.ts` (`/api/shows`)
- `getShowBundle(tvmazeId)` — TVMaze details+cast+seasons+episodes+images + Wikipedia overview + JustWatch where-to-stream + YouTube media + reviews + Plex availability; parallel, each piece `cachedLookup`-wrapped + fault-tolerant.
- `getHomeShelves()` — Trending (JustWatch popular→SHOW), New & Notable (JustWatch new), On TV This Week (TVMaze `/schedule`), By Genre (TVMaze). ~30min cache.
- Routes: `GET /home`, `/search?q=`, `/:id`, `/:id/episodes?season=`, `/genre/:g`, `/:id/trivia`, `/:id/media`, `/:id/reviews`; watchlist/progress + podcast (Phases 3–4).

## Movies: `lib/movies/` + `routes/movies.ts` (`/api/movies`)
- `getMovieBundle(ref)` — JustWatch details + where-to-stream + Wikipedia overview + YouTube media + reviews + showtimes(by saved ZIP) + Plex availability.
- `getHomeShelves()` — In Theaters Now (Fandango via showtimes), Trending/Popular (JustWatch popular→MOVIE), New & Notable, By Genre.
- Routes mirror Shows: `GET /home`, `/search?q=`, `/:id`, `/genre/:g`, `/:id/trivia`, `/:id/media`, `/:id/reviews`, `/:id/showtimes?zip=`; watchlist + podcast.

## DB (schema.ts + inline `runMigrations()`, no db:generate)
- `mediaWatchlist` (id, userId, mediaType ['show','movie'], refId, title, posterUrl, network/year, status ['want','watching','completed','dropped'], addedAt, updatedAt). Unique (userId, mediaType, refId).
- `showWatchedEpisodes` (id, userId, tvmazeId, episodeId, season, number, watchedAt). Unique (userId, episodeId).
- Plex config: reuse existing integration/tool-config storage (per-user secret).
- Podcast reuse: extend `podcastShows.sourceRef` (`tvshow:<id>`, `movie:<ref>`); add `'tvshow'|'movie'` to `podcastEpisodeSources.sourceType`.

## AI podcasts
- Shows: `tvshow` segment adapter + `summarizeTvEpisode()` (TVMaze synopsis + Wikipedia episode article → premise+beats). One `podcastShow` (`sourceRef=tvshow:<id>`, default companions, `recap`/`in-depth`); queue first 5 episodes (S1E1…) via `download_jobs` `podcast-generate`; "Generate next batch" → next 5; reverse-link `podcastEpisodeSources`.
- Movies: `movie` adapter (Wikipedia plot/reception + reviews → premise+beats) → single deep-dive episode.

## Frontend
- Shared components in `shared/` (update agents.md catalog): `BackdropWallpaper`, `TitleHero`, `StreamingChips`, `PlexBadge`, `VideoRow`, `ReviewsSection`, `TriviaSection`, `EpisodeList`, `ShelfRow`, `TitleCard`.
- `pages/shows/ShowsHomePage.tsx` + `ShowDetailPage.tsx`.
- `pages/movies/MoviesHomePage.tsx` + `MovieDetailPage.tsx` (adds Showtimes panel by ZIP + In-Theaters shelf).
- Detail pages: full-bleed blurred backdrop + scrim; poster/title/year/network-or-studio/status/rating/genres; CSM age badge; where-to-stream chips; Plex badge + Play-on-Plex; actions (Add to Watchlist [+ Plex Watchlist], Generate Podcast); sections — Overview, Reviews, Parents Guide (CSM), Episodes (shows) / Showtimes (movies), Cast, Videos, Music & Theme, Trivia, Podcast, Images.
- API clients `lib/api/shows.ts`, `lib/api/movies.ts`; reuse `usePodcastPlayback`, `useBreadcrumbSearch`.
- `App.tsx`: `/shows`, `/shows/:id`, `/movies`, `/movies/:id`; redirect `/tv-shows`→`/shows`.
- `appCategories.ts`: rename "TV Shows"→"Shows"; add "Movies"; keep "Movie Showtimes" (or fold into Movies); icons Tv / Clapperboard.

## Companion tools
- Keep/enhance `tvshows`; optionally add a `movies` lookup tool surfacing where-to-stream + showtimes + Plex availability.

## Phases
1. **Shared core + Shows** — rename to Shows; `lib/titles/` (backdrop, media, reviews, trivia, imageProxy); `lib/shows/`; generic image proxy; `routes/shows.ts` (home/search/:id/episodes/genre/media/reviews); ShowsHomePage + ShowDetailPage with wallpaper, streaming, reviews, videos, music, cast, overview, episodes.
2. **Movies** — `lib/movies/`; `routes/movies.ts`; reuse `fetchShowtimes`; MoviesHomePage (incl. In Theaters) + MovieDetailPage (incl. Showtimes panel); reviews/trivia/media via shared core.
3. **Tracking + trivia + images** — `mediaWatchlist` + `showWatchedEpisodes`; watchlist/progress endpoints; Continue Watching / Your Watchlist shelves (both apps); episode checkmarks; trivia/did-you-know live; images galleries.
4. **AI podcasts** — `tvshow` + `movie` adapters; `summarizeTvEpisode`; podcastShow linking; Shows batch-of-5 + Next Batch; Movies deep-dive; Podcast tab + player.
5. **Plex** — `lib/plex/`; config UI (Admin); availability badges + Play-on-Plex; "From your Plex" shelf; Add-to-Plex-Watchlist.
