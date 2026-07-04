---
title: Books
description: The ebook/audiobook storefront, save-vs-download library model, TTS-to-audiobook, and the AI book authoring pipeline.
sidebar:
  order: 9.5
---

## Overview

Books (`/books`) is a storefront across several ebook/audiobook sources with a per-user library, backed by a shared `books` catalog so two users adding the same title share one row (and, once downloaded, one on-disk copy, via the same content-addressable `media_assets`/blob store used by podcasts and YouTube offline saves). A book/textbook/manual-shaped archive from the same ZIM/kiwix mechanism as [Reference](../reference/) also shelves here, driven by `ZimSource.bookCategory` (see that page), unrelated to the tables below.

Key files:

- `backend/src/routes/books.ts`: search, library, save/download, reading/listening progress, streaming
- `backend/src/routes/booksGenerate.ts`: AI authoring project CRUD + approval gates
- `backend/src/routes/adminBooks.ts`: source toggles, Google Books key, custom OPDS indexers
- `backend/src/lib/books/{gutenberg,standardEbooks,archiveOrg,librivox,wikisource,openLibrary,googleBooks,indexer,opds}.ts`: one module per source
- `backend/src/lib/books/offline.ts`: download-job pipeline (`book-download`)
- `backend/src/lib/books/tts.ts`: EPUB → audiobook render (`book-tts`)
- `backend/src/lib/books/generate/{storyBible,chapter,covered,commit,generate}.ts`: AI authoring pipeline
- `frontend/src/pages/books/`: `BooksDiscoverPage`, `BooksLibraryPage`, `BookDetailPage`, `BookReaderPage`, `AudiobookPlayerPage`, `BooksAudiobooksPage`, `BooksSourcesPage`, `BooksUploadPage`, `MagazinesPage`, `ArchiveBrowsePage`/`BookCategoryPage` (ZIM book packs), `generate/*` (authoring wizard), `readers/{Epub,Pdf,Comic}ReaderView.tsx`
- Tables: `books`, `bookChapters`, `bookLibrary`, `bookProgress`, `bookIndexers`, `bookProjects`, `bookProjectChapters`

---

## Data model

`books` is the shared catalog: one row per title regardless of who added it, deduplicated per source via a `(sourceType, sourceRef)` unique index (`sourceRef` is the external id/URL, the upload/AI-generated cases have no natural key so they just don't collide). `contentType` distinguishes `book | magazine | children | comic | manga | coloring_book`; `sourceType` is `upload | gutenberg | standardebooks | archiveorg | wikisource | googlebooks | openlibrary | indexer | librivox | manual | ai-generated`.

`bookChapters` is one row per chapter/spine-item, shared by the EPUB TOC nav and audiobook chapter markers. Multi-track audiobooks (LibriVox, one file per chapter on Internet Archive) set `externalAudioUrl`/`externalAudioDurationSec` and stream directly from that URL via `/api/books/:bookId/chapters/:idx/stream`, instead of seeking into one shared file with `audioStartSec`/`audioEndSec` offsets.

`bookLibrary` is per-user "in my library" membership, presence here (not just a `books` catalog row) is what surfaces a title on the user's Library page. `status` distinguishes a lightweight `'saved'` (metadata only, no bytes on disk) from the offline-download lifecycle `'pending' → 'downloading' → 'ready'` (or `'failed'`); only `'ready'` has a local copy.

`bookProgress` holds one row per `(user, book)` with whichever mode (`reading` | `listening`) was last touched, `epubCfi` for reading position, `audioPositionSec`/`audioChapterIdx` for listening (the latter needed because multi-track audiobooks have no single seekable timeline). Switching modes does not carry position across.

---

## Sources

| Source | Module | Notes |
|---|---|---|
| Project Gutenberg | `gutenberg.ts` | Public-domain classics; numeric-id scheme |
| Standard Ebooks | `standardEbooks.ts` | `sourceRef` is the direct `.epub` URL captured at browse time, no per-book lookup |
| Internet Archive | `archiveOrg.ts` | Ebooks + audiobooks |
| LibriVox | `librivox.ts` | Multi-track audiobooks (Internet Archive-hosted, one MP3 per chapter) |
| Wikisource | `wikisource.ts` | Reference-style texts |
| Open Library / Google Books | `openLibrary.ts` / `googleBooks.ts` | Metadata enrichment, Google Books needs an admin-configured API key |
| Custom OPDS indexers | `indexer.ts` / `opds.ts` | Self-hosted (Calibre-Web, Kavita, COPS…), admin-managed rows in `bookIndexers` (`Admin → Integrations → Books`), replaced an earlier single-slot `tool_global_config` design |
| Upload | n/a | User-supplied EPUB/PDF/CBZ/CBR |

`sourceToggles.ts` lets an admin disable a built-in source without deleting anything.

---

## Save vs. download

Adding a book to the library always inserts (or reuses) a `bookLibrary` row. **Save** (`POST /save`) sets `status='saved'`, metadata only. **Download** (`POST /download`, or `POST /:id/download-offline` to upgrade an already-saved title) enqueues a `book-download` job.

`offline.ts` mirrors `podcast/offline.ts`'s shape: one `media_assets` rendition per book (`sourceType='book'`, `sourceId=bookId`, `kind='ebook'`), resolved per source type (`resolveGutenbergDownload` / `resolveArchiveOrgDownload` / `resolveIndexerDownload` / `resolveWikisourceDownload`, or the direct URL for Standard Ebooks). Because the asset is content-addressed in the shared blob store, two users downloading the same book share one copy on disk.

---

## TTS-to-audiobook

`enqueueBookTtsRender` (`tts.ts`) converts an EPUB to a synthesized audiobook (`book-tts` job), currently **EPUB-only**, there's no clean text-extraction path for PDF/CBZ yet. It reuses the [narration engine](/dev/subsystems/voice/)'s primitives directly rather than duplicating them: `detectTurns`/`normalizeSpeakers` for per-chapter speaker detection, `assignVoices` for the voice pool, and `synthesizeTurnsToPcm`/`wavToMp3` for rendering. It deliberately does **not** create a `narrationSessions` row per chapter, that table belongs to the standalone "Cast voices" feature; a book's speaker detection here is transient, used once to render audio and then discarded.

---

## AI book authoring

`bookProjects` is a single-user draft workspace, kept separate from the shared `books` catalog so an abandoned or rejected generation never surfaces in anyone's library. Modes: `create` (from a premise), `continue` (extend an existing book), `reshape` (regenerate with a different instruction, e.g. a new ending or POV). Once approved end to end, `commitProjectToBook()` materializes a real `books` row (`sourceType='ai-generated'`) and sets `resultBookId`.

Status pipeline: `drafting_bible → pending_bible_approval → pending_sample → pending_sample_approval → generating → completed` (or `pending_reshape_review` for reshape mode, `failed`/`cancelled`).

| Stage | File | What happens |
|---|---|---|
| Story bible | `generate/storyBible.ts` | LLM drafts characters/setting/tone/themes + a chapter outline (`outlineJson`), user-editable before approval |
| Sample chapter | `generate/chapter.ts` | Generates chapter 0 only (`isSampleRun: true`), gated on user approval before committing to the rest |
| Full generation | `generate/generate.ts` (`runBookGenerateJob`) | Walks the outline's chapter range through `generateChapter`, updates `coveredSummaryJson` (a running continuity summary) after each chapter so later chapters stay consistent |
| Commit | `generate/commit.ts` | Materializes the finished draft into `books`/`bookChapters` |

Runs inside the download queue (`downloadJobs`, type `book-generate`), mirroring `podcast/generate.ts`'s orchestration shape. `bookProjectChapters` holds per-chapter draft state decoupled from the published `bookChapters` list, since drafts may be regenerated or rejected; reshape mode keeps both an original reference and an AI-regenerated alternate per chapter for the user to pick between.

`getUserCeiling` / `buildContentPrompt` (`contentPolicy.ts`) clamp generation to the requesting user's content profile, same as chat.

---

## Routes (`backend/src/routes/books.ts`, all `requireAuth` unless noted)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/search`, `/search/catalog`, `/search/librivox` | Cross-source search |
| `GET` | `/categories`, `/magazines/categories`, `/librivox/categories` | Built-in browse categories (+ `/browse-all`, `/:topic/full` variants) |
| `GET` | `/sources` | Installed sources incl. custom indexers |
| `POST` | `/upload` | User EPUB/PDF/CBZ/CBR upload |
| `POST` | `/save`, `/download`, `/:id/download-offline` | Library add, two-tier as above |
| `GET` | `/library`, `/library/index` | The caller's library |
| `POST` | `/library/remove` | Remove from library |
| `GET` | `/:id`, `/:id/chapters`, `/:id/file`, `/:id/audio`, `/:id/cover` | Book detail + asset serving |
| `GET` | `/:id/chapters/:idx/stream` | Multi-track audiobook chapter stream (range-forwarded from the external URL) |
| `PUT` | `/:id/progress` | Upsert `bookProgress` |
| `POST` | `/:id/tts`, `GET /:id/tts/status` | Kick off / poll TTS-to-audiobook render |
| `POST` | `/:id/retry-download` | Re-queue a failed download |

`booksGenerate.ts` mounts the authoring project routes (`/generate/projects[/:id]`, `.../bible`, `.../approve-bible`, `.../regenerate-sample`, `.../approve-sample`, `.../reject`, `.../status`, `.../chapters/:idx[/regenerate]`, `.../commit`).
