<p align="center">
  <img src="assets/icons/brand.svg" width="72" alt="Loki Doki" />
</p>

# Agent Guidelines - loki-doki-v3

## Git, Branching & Multi-Session Workflow

**Land all work directly on `main`. Never open GitHub pull requests.** Commit finished changes straight onto the local `main` branch. Do not create PRs and do not use the remote as a review step. "Everything on main" is the model: `main` is the single source of truth and the branch the live app runs on.

**Never push to the remote (GitHub) without the user's explicit permission, every time.** Local commits to `main` are the normal flow, but publishing to the remote always requires a fresh, explicit go-ahead in that moment. Permission never carries over from one push to the next, and the nature of the task never implies it. When work is ready to publish, stop and ask.

**Keep parallel Claude sessions from stepping on each other with worktrees, not by editing the live tree directly.** The goal is two things at once: changes visible in the running app right away, and no two sessions clobbering each other's files.
- The live app runs from the canonical checkout, kept on `main`, with the dev servers running (Vite HMR for the frontend, Bun for the backend). Anything that lands on `main` and updates that working tree shows up live through HMR within seconds.
- Each session that will edit code works in its own git worktree on its own short-lived branch (under `.claude/worktrees/`), so its edits never touch the live tree while work is in progress.
- When a change is ready and builds clean, land it by merging (or cherry-picking) that branch onto `main`, then let the live checkout pick it up. No PR. Delete the worktree afterward.
- Land one session's work at a time so two merges never race. Real overlaps surface as git conflicts to resolve instead of silent clobbers.
- If only one session is active, you can skip worktrees and edit the live `main` checkout directly; HMR then reflects every change instantly. Reach for worktrees specifically when more than one session is running.

## Context Rule

**Always interpret questions in the context of this app.** When the user asks about a feature, behavior, or concept without specifying a domain, assume they mean loki-doki-v3 - not a general knowledge question. If the question is genuinely ambiguous, ask for clarification before answering generically.

## Writing Style

**Never use em dashes (the long dash, Unicode U+2014) in any prose we write.** This covers documentation, UI copy, code comments, and commit messages. Use a comma, colon, parentheses, or a period instead, whichever fits the sentence. En dashes (`–`) are acceptable only for numeric ranges (for example, `2–8 users`). Em dashes are a strong "machine-generated" tell, so keep them out of everything user-facing.

## Model Strategy

`opusplan` is active - Opus in plan mode, Sonnet in execution.

Use `/plan` before starting:
- Architecture changes
- Large refactors
- New subsystems
- Database schema changes
- API redesigns

Stay in execution mode for:
- Bug fixes
- Small features
- Test fixes
- Documentation

## Minimum Testing Requirements

After writing or editing any frontend code, **always run `npx vite build` in `frontend/` before declaring done.** A successful Vite build (no errors, exit 0) is the minimum bar. `tsc --noEmit` passes but Vite's Babel transform catches additional errors (e.g. syntax errors in JSX/TSX that TypeScript misses). Never rely on `tsc` alone.

After writing or editing backend code, run `bun run check:build` from `backend/` (exit 0 = clean) to confirm the module graph resolves without errors. It wraps `bun build --target=bun src/index.ts` and marks playwright's optional `chromium-bidi` requires as external, since those modules are lazy-loaded and intentionally not installed.

If either build fails, fix the errors before reporting the task complete.

After touching any frontend UI file, also run `bun run check:design-contract` from `frontend/`.
It greps the diff's files for the mechanical Visual Language violations (em dashes, hardcoded
`violet-*`, `window.confirm`/`window.alert`) - see Visual Language below.

---

## Tech Stack

**Runtime & tooling**
- Bun (package manager and runtime - use `bun` not `npm`/`yarn`)
- Vite 6 + `@vitejs/plugin-react`
- TypeScript ~5.8

**UI layer**
- React 18
- Tailwind CSS v4 (CSS-first config via `src/index.css`, no `tailwind.config.js`)
- Design tokens (OKLCH) - `--brand`/`--brand-foreground` are the accent token; use `bg-brand`, `text-brand`, `border-brand`, `ring-brand` utilities. Never hardcode `violet-500` or the `primary` token for accent UI. Dark mode: `--brand: oklch(0.72 0.22 290)`. Light mode: `--brand: oklch(0.44 0.22 290)`.
- shadcn/ui - style: `new-york`, base color: `neutral`, CSS variables enabled
- Radix UI (via `radix-ui` package - primitives shadcn is built on)
- lucide-react (icon library - use these icons, do not add others). Exception: the Music app's
  station art (`components/music/StationArt.tsx`) uses **filled** `@tabler/icons-react` icons for
  silhouette covers, because lucide has no filled variants. Use lucide everywhere else.
- dnd-kit (`@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/modifiers`, `@dnd-kit/utilities`)
- react-router-dom v6

**Utility**
- `clsx` + `tailwind-merge` - always compose via `cn()` from `@/lib/cn`
- `class-variance-authority` for variant-based component APIs

**Desktop shell (`desktop/`)**
- Electron (plain-JS CJS main process, no build step; `bun install` with `trustedDependencies`)
- A thin wrapper that loads the web app **from the server** (`http://<server>:3000`) - no bundled
  frontend, so features ship via the server. Two windows on one `persist:loki` partition:
  the always-on-top voice HUD (route `/hud`, `frontend/src/pages/HudPage.tsx`) and the full app.
- Renderer↔shell bridge: `window.lokiDesktop` (`desktop/src/preload.js`, typed in
  `frontend/src/types/desktop.d.ts`); all IPC handlers validate the sender's origin.
- Voice-ownership rule: the HUD window never fully hides while hands-free is armed (visibility
  keeps mic ownership per `voiceOwnership.ts`) - it shrinks to a pill instead.
- Builds: `.github/workflows/desktop-build.yml` (workflow_dispatch, or Release on `desktop-v*` tags);
  unsigned installers - see `desktop/README.md`.

**Backend**
- Hono - lightweight, Bun-native HTTP framework
- Database: SQLite via Bun's built-in `bun:sqlite` + Drizzle ORM
  - SQLite is the correct default for a local family app (2–8 users, single file, easy backup)
  - `DATABASE_URL` overrides the SQLite file *path* only (the DB layer is SQLite-only; there is no Postgres driver wired in `backend/src/db/index.ts`)
- TanStack Query - frontend data fetching, caching, background refetch
- Argon2id for PIN hashing - use `Bun.password.hash()` (built-in, no extra dep)
- Pepper via env var `PIN_PEPPER_SECRET` (256-bit hex, never stored in DB)
- Auth: HttpOnly session cookies (not JWT in localStorage - XSS-safe, simpler for single-instance)
- AI calls: always proxied through backend - API keys/Ollama URLs never reach the browser
- Streaming: Server-Sent Events (SSE) for LLM token streaming (`/api/chat/stream`)
- **Streaming render contract:** the SSE token handler replaces the entire `messages` array on every token. Any component rendered in that list **must** be wrapped in `React.memo` - without it, renders scale O(n²) with conversation length. Expensive derived values inside those components (markdown AST, citation transforms) must be `useMemo`'d for the same reason.

**Chat scroll contract (`MessageList.tsx`):**
- On generation start (`isGenerating` → `true`): scroll the user's prompt to the **very top** of the scroll container so only it (and the incoming response below) is visible. Use `getBoundingClientRect()` - not `el.offsetTop` - for the correct scroll offset: `container.scrollTop + elRect.top - containerRect.top - padding`.
- While streaming: auto-follow bottom (instant scroll) only if the user hasn't scrolled up.
- On generation end: smooth-scroll to bottom to reveal the full response.
- On conversation load: instant-jump to bottom.

**Voice / TTS** - see `docs/internal/subsystems.md`
- **Kokoro-82M TTS + Whisper STT**, both via ONE bundled Bun **voice-server sidecar** (`backend/scripts/voice-server.ts`). NOT XTTS/Piper/F5 (cloning deferred; Qwen3-TTS banned - Chinese-origin).
- Pluggable engine registry (`backend/src/lib/voice/`) - `kokoro` only for now.
- Streaming, sentence-chunked: `POST /api/tts/stream` emits one NDJSON PCM payload per sentence. Never batch the whole reply.
- **Bun WS requires `websocket` on the default export in `index.ts`** - load-bearing.

**Deployment**
- Bare Bun only - no Docker
- `bun run start` serves both the API and the built frontend from one process
- Data directory `data/` alongside the server: SQLite file, uploads, model cache, voice samples
- First-run setup wizard on empty DB (create admin account) - no default credentials

Do not introduce new dependencies without discussing first. If a need arises that shadcn, Radix, or the above libraries already cover, use what's there.

**Architecture reference docs** (open when working on those subsystems):
- `docs/internal/llm-architecture.md` - LLM/model catalog, prompt routing, structured output
- `docs/internal/app-structure.md` - routes table, iframe page pattern, auth flow, PIN security
- `docs/internal/subsystems.md` - character system, voice, memory, image gen API, maps, admin
- `docs/internal/image-stack.md` - ComfyUI runtime, model downloads, memory budgets
- `docs/internal/chat-latency.md` - chat pipeline, latency tuning

---

## Component Hierarchy

```
src/components/
  ui/         ← shadcn primitives (generated, do not hand-edit)
  shared/     ← reusable app-level components (centralized here)
  chat/       ← feature-scoped components
  shell/      ← AppShell, BottomNav, GlobalChatInput, LeftSidebar, SubtitleBar
  auth/       ← login, profile selection, PIN entry
  settings/   ← settings modal tabs
  admin/      ← admin panel tabs (admin-only)
  devtools/   ← developer tools tabs (admin-only)
  ...         ← other feature dirs
```

### Decision order when building UI

1. **Use a `ui/` primitive** - if shadcn already has it (Button, Badge, Dialog, Input, etc.), use it as-is.
2. **Use a `shared/` component** - if a richer/composed version already exists in `shared/`, use it. See catalog below.
3. **Add to `shared/`** - if you're building something that combines multiple primitives into a reusable pattern, put it in `shared/`, not inline.
4. **Add to the feature dir** - only if the component is genuinely specific to one feature and has no plausible reuse elsewhere.

**Never duplicate.** If `shared/` already has a component that does the job, use it. Do not recreate it inline or in a feature dir.

---

## Shared Component Catalog

### App Header Contract (read this first for any app page)

Every app shares ONE header system so they look and behave identically. Do not hand-roll a
header, a title row, or a background tint on an app page. The pieces:

**1. Breadcrumb (automatic).** `AppShell` renders the breadcrumb (`Home / Group / App`) for every
non-home app route from the `APP_GROUPS` registry (`src/lib/appCategories.ts`), icon, name, and
accent color all come from the registry. You get this for free; you do not render it.

**2. Reload-on-click (automatic).** The app crumb (icon + name) is a button that reloads the app:
it navigates to the app root and remounts the route (resetting tab/scroll/search/query state).
Layout apps with a persistent rail/player (YouTube, Bookmarks, Chat) keep that rail mounted during
normal internal navigation and only fully reload when the crumb is clicked, this works because the
`Outlet` is keyed by **app root**, not full pathname. Nothing to wire per page.

**3. Background tint (automatic).** The app's registry `color`/`gradient` tints the right panel
(corner fade + ghost-icon watermark), like Chat. `AppShell` paints it for standard scroller apps;
full-bleed / chat pages get it from `PageShell`. Keep your page root transparent and it shows
through. See `AppBackdrop` below, you rarely use it directly.

**4. Header actions (opt in via `useAppHeader`).** To add a search box, external link, admin
settings gear, or global toggle buttons to the breadcrumb row, call **`useAppHeader(...)`** from
`src/context/BreadcrumbSearchContext.tsx` in your page. This is the ONLY sanctioned way to populate
the action row, never inject buttons into the breadcrumb yourself.

```ts
useAppHeader({
  query, setQuery,            // search box (required to render the input)
  onSubmit,                   // omit for live-filtering (no Search button)
  placeholder: 'Search…',
  loading,                    // spinner in the Search button
  externalHref: 'https://…',  // external-link icon (new tab)
  settingsHref: '/admin/…',   // admin-only gear (hidden for non-admins)
  leftSlot, rightSlot,        // global toggle buttons (e.g. YouTube online/offline)
})
```

The config auto-clears on unmount. `useAppHeader` (and `AppHeaderConfig`, `useAppHeaderConfig`) is
the current name; `useBreadcrumbSearch` is a back-compat alias, prefer `useAppHeader` in new code.

**5. Sub-tabs (use `AppTabBar`).** Tabbed apps keep their tab row in the page body (just under the
breadcrumb) but render it via `AppTabBar` so every tabbed app looks identical. See below.

**6. In-page app identity (icon tile + name).** Never hand-roll the app's icon tile with a hardcoded
color, it drifts from the registry and the breadcrumb. The app's icon must render in its **registry
gradient** (`app.gradient`) with the **registry icon** (`app.icon`):
- Layout apps with a left rail (YouTube, Bookmarks, Podcasts, Companions, App Store) use
  **`AppRailHeader`** (resolves icon+gradient from the registry by route).
- Standard scroller apps use `PageHeader variant="compact"`, whose icon tile is painted with the
  `gradient` you pass (use the app's registry gradient).

---

### `AppBackdrop` - `src/components/shared/AppBackdrop.tsx`

The app color-identity layer: a corner-fade tint (from the app gradient) + a faint ghost-icon
watermark. Render as an `absolute inset-0` sibling behind `relative z-10` content. Usually applied
for you by `AppShell` / `PageShell`, only reach for it directly on a custom full-bleed surface.

```ts
{ gradient?: string; GhostIcon?: LucideIcon }
```

---

### `AppTabBar` - `src/components/shared/AppTabBar.tsx`

The standardized in-body sub-navigation pill row for tabbed apps (Music, etc.). Use it instead of
hand-rolling a tab row.

```ts
{ tabs: AppTab<T>[]; value: T; onChange: (id: T) => void; className?: string }
// AppTab: { id: T; label: string; icon?: LucideIcon; shortLabel?: string }
```

`shortLabel` (defaults to the first word of `label`) is shown on narrow screens.

---

### `AppRailHeader` - `src/components/shared/AppRailHeader.tsx`

The standardized app-identity header for layout apps with a left rail. Renders the app's registry
icon in its registry gradient tile (matching the breadcrumb tile) + name + description. Icon and
gradient resolve from the registry by route; pass `icon`/`gradient` explicitly only for routes not
in `APP_GROUPS` (e.g. App Store).

```ts
{ title: string; description: string; icon?: LucideIcon; gradient?: string; className?: string }
```

---

### `RichOptionSelect` - `src/components/shared/RichOptionSelect.tsx`

A searchable dropdown/combobox with rich per-option content: title, subtitle/description, and badges. Built on `Radix Popover` + `Badge`.

**Use this whenever you need:**
- A `<select>`-like picker with more than plain text per option
- Options with descriptions, status badges, or a "Recommended" flag
- Search/filter across options (auto-shown when > 5 options)
- Grouped options with section headers

**Props:**
```ts
groups: RichOptionGroup[]   // { label?: string; options: RichOption[] }
value: string
onChange: (value: string) => void
placeholder?: string
triggerClassName?: string
disabled?: boolean
```

**`RichOption` shape:**
```ts
{
  value: string
  label: string
  description?: string       // subtitle shown below label
  badges?: { text: string; variant?: BadgeProps["variant"] }[]
  recommended?: boolean      // auto-adds a "Recommended" info badge
  disabled?: boolean
}
```

---

### `ModelCard` / `ModelCardGroup` - `src/components/shared/ModelCard.tsx`

Card-based model selector matching the old-app screenshot pattern: name, active/not-installed badge, tag chips (fast/quality/recommended/fallback/uncensored/accurate), size label, format, backend, description line. `ModelCardGroup` renders a list and manages single-selection.

**Props (`ModelCard`):**
```ts
option: ModelCardOption   // { id, label, description, sizeLabel, format?, backend?, tags?, installStatus }
selected: boolean
onClick: () => void
```

**Props (`ModelCardGroup`):**
```ts
options: ModelCardOption[]
value: string             // selected id
onChange: (id: string) => void
```

**`installStatus`:** `'active'` | `'installed'` | `'not_installed'`

Use in the Admin Panel model selection tabs - one `ModelCardGroup` per role (llm, uncensored_llm, vision, image_gen).

---

### `DismissableCard` - `src/components/shared/DismissableCard.tsx`

Wraps any suggestion-rail card with a "Not interested" X button (hover-revealed on pointer devices, always visible on touch). Used by every "Suggested for you" rail (Videos, Shows, Movies, Podcasts, Music) together with the `useSuggestionDismiss(domain)` hook (`src/hooks/useSuggestionDismiss.ts`), which handles optimistic hiding, the Undo toast, and the `/api/interests/dismiss` round trip.

**Use this for** any card the interest engine suggests - never hand-roll a per-rail dismiss affordance.

**Props:** `onDismiss: () => void`, `children`.

---

### `PitchBanner` - `src/components/shared/PitchBanner.tsx`

A compact gradient "try this feature" banner (icon + title + blurb + CTA) with a persistent dismiss X. Dismissal is stored per user in `user_preferences` under the caller-supplied `prefKey` (e.g. `podcasts.createBannerDismissed`), so it sticks across visits and devices; the banner stays hidden while preferences load so a dismissed banner never flashes in. Used by Podcasts ("Make your own AI podcast", Listen Now) and Music ("Make your own station", Home).

**Use this for** any in-app pitch of a creation feature - never build a one-off banner Card, and never make a pitch banner the user can't dismiss.

**Props:** `prefKey`, `icon`, `title`, `description`, `gradient?` (pass the app's `getAppByPath(...)?.gradient`), `action` (ReactNode CTA, typically a `Button variant="secondary"`).

---

### `SpotlightSearch` - `src/components/shared/SpotlightSearch.tsx`

A spotlight-style search modal (think macOS Spotlight). Renders both the sidebar trigger button (Search icon + label + ⌘K/Ctrl K badge) and the Dialog. Opens via button click or Ctrl/⌘+K. Supports arrow-key navigation and Enter to navigate. Uses `Dialog` root + raw `RadixDialog.Content` (no built-in close button) from Radix.

**Use this for** the global search trigger in the left sidebar - do not recreate inline.

No props - self-contained with internal open state.

---

### `DownloadProgress` - `src/components/shared/DownloadProgress.tsx`

Animated download card with progress bar, stats, and controls. Supports pause/resume/cancel/retry.

**Status values:** `idle` | `pending` | `downloading` | `paused` | `completed` | `error` | `cancelled`

**Props:**
```ts
label: string
description?: string
status: DownloadStatus
progress?: number          // 0–100 (auto-computed from bytes if omitted)
downloadedBytes?: number
totalBytes?: number
speedBps?: number          // bytes/sec - shown as "X MB/s" while downloading
etaSeconds?: number        // shown as "Xm Ys remaining" while downloading
error?: string
onStart?: () => void
onPause?: () => void
onResume?: () => void
onCancel?: () => void
onRetry?: () => void
```

**Visual:** animated blue→violet gradient bar while downloading, amber when paused, emerald on completion, red on error. Shimmer overlay animates across the fill. Card border tints to match status.

---

### `PageShell` - `src/components/shared/PageShell.tsx`

Transparent page wrapper that carries the app's color identity. Delegates the tint to `AppBackdrop`
and, importantly, only self-tints on full-bleed / chat routes that `AppShell` does NOT cover, on
standard scroller apps the shell already paints the backdrop, so `PageShell` stays a transparent
pass-through and the tint is applied exactly once. Existing pages can keep wrapping in `PageShell`
unchanged; new standard apps don't need it at all (the shell tints them regardless).

```ts
{ gradient?: string; GhostIcon?: LucideIcon; children: ReactNode; className?: string }
```

The gradient/icon default to the current app's registry entry when omitted. Pass them explicitly
only for a custom full-bleed surface.

---

### `PageHeader` - `src/components/shared/PageHeader.tsx`

Standard page header for scroll pages that need a plain or hero header. Do not use for pages that already use `PageShell`.

**`variant="plain"` (default):** `text-3xl sm:text-4xl font-black tracking-tight`, optional uppercase eyebrow and muted subtitle. Standard padding `px-5 pt-10 pb-6`.

**`variant="hero"`:** Full-bleed gradient banner with icon tile + eyebrow + title + optional CTA.

```ts
// plain
{ variant?: "plain"; eyebrow?: string; title: string; subtitle?: string; actions?: ReactNode; className?: string }
// hero
{ variant: "hero"; eyebrow?: string; title: string; subtitle?: string; gradient: string; icon?: ReactNode; cta?: ReactNode; className?: string }
```

---

### `SectionHeader` - `src/components/shared/SectionHeader.tsx`

Bold section title with optional "See all" link. Replaces all hand-rolled section-label patterns (`text-lg font-bold tracking-tight`, optional `ChevronRight`).

```ts
{ title: string; to?: string; lead?: string; className?: string }
```

---

### `ToggleRow` - `src/components/shared/ToggleRow.tsx`

The house settings toggle row (bordered card, semibold title + muted description, `Switch` pinned right). Extracted from the YouTube settings tab; use it instead of hand-rolling label+Switch rows. Optional `chip` renders a small badge next to the title.

```ts
{ title: string; description: string; checked: boolean; onCheckedChange: () => void;
  disabled?: boolean; chip?: ReactNode; className?: string }
```

---

### `CompanionAbilitiesCard` - `src/components/shared/CompanionAbilitiesCard.tsx`

"Companion abilities" section for an app's settings page: one `ToggleRow` per chat tool the app ships (mapping in `src/lib/companionAbilities.ts`). Household-global, admin-only toggles (non-admins see a lock note); writes `PUT /api/tools/:id/chat-enabled` for app-backed tools or `/enabled` for standalone abilities. Renders nothing when the app hosts no abilities.

```ts
{ appId: string }  // APP_GROUPS app id
```

---

### `ChipRow` / `Chip` - `src/components/shared/ChipRow.tsx`

TikTok-style horizontally-scrollable pill filter row. `Chip` active state uses `bg-brand text-brand-foreground`; inactive uses `bg-foreground/8`. `ChipRow` is a `no-scrollbar flex gap-2 overflow-x-auto` wrapper.

```ts
// Chip
{ label: string; active?: boolean; onClick?: () => void; className?: string }
// ChipRow
{ children: ReactNode; className?: string }
```

---

### `TrackVariantGrid` - `src/components/shared/TrackVariantGrid.tsx`

Variant picker grid with a shared audio player, the audio sibling of the cover-art grid. Used by the podcast `StingerPicker` (intro/outro) and the Music app's Generate/Remix tabs. Generic over any item with `{ key, label, previewUrl }`; renders play/pause + select, with optional `sublabel`, `selectedKey`, `pickingKey`, `loading`, `error`, and `columns` (1/2/3).

```ts
{ variants: T[]; loading?: boolean; error?: string | null; selectedKey?; pickingKey?;
  onSelect: (v: T) => void; columns?: 1 | 2 | 3; sublabel?: (v: T) => string | null }
```

---

### `Card` variants - `src/components/ui/card.tsx`

The shadcn `Card` now exports a `cardVariants` CVA export with four variants. Prefer these over hand-rolled card divs:
- `surface` (default) - `rounded-2xl border border-border/60 bg-card`
- `interactive` - surface + `cursor-pointer hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-lg active:scale-[0.99]`
- `gradient` - `rounded-2xl text-white` (add your own gradient via `style` or `className`)
- `dashed` - `rounded-2xl border-2 border-dashed border-border/60 bg-card/40` (empty-state prompt cards)

---

### `AppSettingsShell` - `src/components/shared/AppSettingsShell.tsx`

THE shell for every app's own settings page (extracted from the YouTube settings layout so
they all look identical): PageHeader up top, collapsible left section sidebar
(`SettingsSidebar`, same anatomy as Settings/Admin), mobile drawer. Reached via the
breadcrumb gear (`useAppHeader({ settingsHref })` — bespoke pages use `/{app-route}/settings`,
everything else the generic `/apps/{appId}/settings` route, which renders the Companion
abilities section). Never point `settingsHref` at Admin - a per-app settings page is
reachable by every user. Sections with `adminOnly: true` render their content for admins and
a locked notice for everyone else. Section state is internal by default; pass
`activeSection` + `onNavigate` to drive it from a `/:section?` route param (YouTube, the
generic page). Apps hosting companion abilities include a `companion` section with
`<CompanionAbilitiesCard appId=... />`.

```ts
{
  appId: string              // collapse-pref key: "{appId}.settingsSidebarCollapsed"
  title?: string             // default "Settings"
  icon?: LucideIcon          // the app's registry icon
  gradient?: string          // the app's registry gradient
  sections: AppSettingsSection[]  // { id, label, icon, content, adminOnly? }
  activeSection?: string     // controlled (URL-driven) mode
  onNavigate?: (id) => void
}
```

---

### `WidgetErrorBoundary` - `src/components/shared/WidgetErrorBoundary.tsx`

Per-tile error boundary for dashboard-style widgets (used by the Home canvas around every widget renderer). Catches a render throw inside one widget and shows a compact muted card ("This widget hit an error") with a Retry (remount) button, instead of letting the error bubble to the app-wide `ErrorBoundary` and blank the page. Wrap once at the lowest common render point of each tile.

---

### `ConfirmDialog` - `src/components/shared/ConfirmDialog.tsx`

Reusable confirmation modal. Use this for every destructive action (delete, reset, etc.) - do not build inline confirmation UI.

**Rule: every delete action must use `ConfirmDialog`. Never use `window.confirm()`. Always set `destructive` for irreversible actions.**

Pattern:
```tsx
const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

// In the button:
onClick={() => setConfirmDeleteId(item.id)}

// After the return:
<ConfirmDialog
  open={confirmDeleteId !== null}
  onOpenChange={open => !open && setConfirmDeleteId(null)}
  title="Delete this item?"
  description="This will permanently remove the item. This action cannot be undone."
  confirmLabel="Delete"
  destructive
  onConfirm={() => { if (confirmDeleteId) { void handleDelete(confirmDeleteId); setConfirmDeleteId(null) } }}
/>
```

**Props:**
```ts
open: boolean
onOpenChange: (open: boolean) => void
title: string
description?: string
confirmLabel?: string   // default: "Confirm"
cancelLabel?: string    // default: "Cancel"
destructive?: boolean   // default: false - uses destructive variant on confirm button
onConfirm: () => void
```

---

### `ColorPicker` - `src/components/shared/ColorPicker.tsx`

Dropdown color swatch picker with 8 named color choices. Also exports `resolveProjectColor(slug)` for converting a color slug to a concrete CSS value (used with `color-mix` for tinted icon backgrounds).

**Props:**
```ts
value: string | null
onChange: (slug: string | null) => void
```

**Exports:** `ColorChoice`, `COLOR_CHOICES`, `resolveProjectColor`

---

### `IconPicker` - `src/components/shared/IconPicker.tsx`

Searchable grid icon picker with 52 lucide icons. Also exports `getIconChoice(slug)` to resolve a slug to its `{ slug, label, Icon }` object.

**Props:**
```ts
value: string | null
onChange: (slug: string | null) => void
```

**Exports:** `IconChoice`, `ICON_CHOICES`, `getIconChoice`

---

### `BrandMark` - `src/components/shared/BrandMark.tsx`

The Loki Doki app logo. Renders the canonical brand mark from `/favicon.svg` (single source of truth, update that SVG and every surface follows: browser tab, sidebar, setup wizard, boot screen). Never re-create the logo inline; always use this component.

**Props:**
```ts
className?: string   // size via `size-*` (the SVG carries its own rounded tile + gradient)
glow?: boolean       // soft violet bloom hugging the squircle, for hero placements (boot/setup)
```

### `SpaceBackdrop` - `src/components/shared/SpaceBackdrop.tsx`

Decorative deep-space scene: twinkling starfield, occasional shooting stars, and a slowly drifting UFO over a deep-space radial gradient. `pointer-events-none` (never captures input). Designed to sit **behind** a transparent globe/planet canvas. Used by the Maps globe view (`MapsPage`, mounted only at globe zoom) and the Moon Phase app (`MoonPhasePage`).

```ts
{ starCount?: number; shootingStars?: boolean; ufo?: boolean; className?: string }
```

Notes:
- Keyframes live in `index.css` (`star-twinkle` reused; `space-shoot`, `ufo-drift` added). Per-star randomized values are inline styles (genuinely dynamic).
- Place it as an `absolute inset-0 z-0` layer with the real content in a `relative z-10` sibling. Over a dark space backdrop, wrap content in `data-theme="dark"` so themed tokens (foreground/card) stay readable regardless of the app's active theme.

### `AudioVisualizer` - `src/components/shared/AudioVisualizer.tsx`

THE audio-reactive visualizer (there is exactly one; do not hand-roll canvas EQs). One
registry of scenes (`VISUALIZERS`: Soundprint, Ribbons, Dot Grid, Aurora, Spectrum, Radial,
Nebula), two modes and EVERY scene renders in both: `mode="full"` (the immersive stage)
and `mode="strip"` (a short ambient band behind mini players/chrome; center-anchored
scenes have purpose-built strip forms - Soundprint becomes a horizontal loudness timeline,
Radial a bottom-anchored sunrise fan, Nebula a drifting orb). Driven by a real Web-Audio
`AnalyserNode` - never fake motion; no-signal scenes settle and the strip rAF parks
(hidden tabs always park). `useWaveform(ref)` (`lib/music/metaApi.ts`) supplies `peaks`
for Soundprint surfaces.

```ts
{ variant; mode?: 'full' | 'strip'; getAnalyser: () => AnalyserNode | null; palette: Palette;
  active?; peaks?; progress?; opacity?; fade?; className? }
```

Notes:
- Colors come from a `Palette` (`useArtPalette`); surfaces without artwork build one via
  `paletteFromColors(color, colorDark?)` (`lib/artPalette.ts`).
- ONE app-wide per-device scene pref shared by strips AND fullscreen: `useVisualizerPref()` /
  `setVisualizerPref()` (localStorage `music.visualizer`; legacy strip/immersive keys migrate
  on read). Picked from the radio mini bar's `VisualizerMenu` (both breakpoints), the Now
  Playing overflow menu (with None), or the fullscreen stage dropdown.
- Consumers: RadioMiniBar, LiveRadioMiniBar, NowPlayingOverlay bottom band, Music Studio
  header, YouTube audio-only player (strips); ImmersivePlayer (full).

### `UltraBlur` - `src/components/shared/UltraBlur.tsx`

Plexamp-style immersive backdrop: the artwork massively blurred under four hue-diverse corner
radial washes (from `Palette.corners`) with a slow motion-safe drift and a readability scrim on
top. THE backdrop for full-bleed media surfaces (music Now Playing / Immersive player, videos
watch page). Positioned `absolute inset-0`; parent must be `relative`.

```ts
{ artUrl?: string | null; palette: Palette; scrim?: 'default' | 'light' | 'heavy'; className? }
```

Notes:
- `palette` comes from `useArtPalette(url)` / `paletteFromColors(color, colorDark?)`
  (`lib/artPalette.ts`). Art URLs MUST be same-origin (proxied) or extraction silently falls
  back to `DEFAULT_PALETTE`.
- Keyframes `ultrablur-drift` live in `index.css`.

### `BlendedHeroBackdrop` - `src/components/shared/BlendedHeroBackdrop.tsx`

The editorial billboard backdrop (Apple-Music/Spotify pattern): artwork anchored to the right
edge, mask-fading left into an accent gradient, plus a left scrim for text contrast. Drop inside
any `relative overflow-hidden` container (typically `rounded-sheet`); the caller owns the
foreground. Used by the Music home "Station of the day" billboard, music station pages, and the
Videos billboard/heroes.

```ts
{ art: string | null; color: string; colorDark: string; fallback?: ReactNode }
```

### `ArtAccentScope` / `accentVars` - `src/components/shared/ArtAccentScope.tsx`

The app-neutral "retint this subtree from artwork" mechanism (generalized from the Videos
`AccentScope`). `accentVars(palette)` returns inline CSS-var overrides for the GLOBAL chrome
vars every control already reads: `--brand`, `--brand-hover`, `--brand-foreground`, `--ring`,
plus `--accent-soft` (15% color-mix). `ArtAccentScope` wraps a surface, extracts the palette
from `art` via `useArtPalette`, and applies the vars only when art is non-null, so buttons,
tab underlines, and progress bars follow the content with zero per-control edits.

```ts
accentVars(palette: Palette): CSSProperties
<ArtAccentScope art={string | null} className? style?>...</ArtAccentScope>
```

Notes:
- Art must be same-origin (proxied via `proxyImg`/`mediaImg`/`coverUrl` etc.) or extraction
  silently falls back to `DEFAULT_PALETTE`.
- Only use on sanctioned palette surfaces (see Visual Language). Never per-card in a grid:
  one extraction per hero/player/detail surface.
- Videos' `videoAccentVars` composes this and adds the `--yt-accent*` aliases; new apps
  should consume the global vars directly instead of minting app-prefixed ones.

**Dark-shell recipe** (how Music/Videos/media hubs force cinema styling; a documented recipe,
deliberately not a shared layout component since rails/search/mode logic differ per app):
wrap the app's `<Outlet/>` in `<div data-theme="dark" className="... bg-black text-foreground"
style={modeAccentVars}>` where `modeAccentVars` sets the app's static identity accent into
`--brand*`/`--ring` (hexes carry `design-ok(hex-in-tsx)` waivers) plus a faint 4% color-mix
background wash. The layout owns its scroller (route-change scroll reset) and bottom padding
`pb-[max(7rem, ...var(--bottom-chrome)...)]`. The route prefix must be added to `isFullBleed`
in `src/lib/routeChrome.ts`, and pages inside must not use `PageShell` (it would double-paint
`AppBackdrop`). Reference implementations: `MusicLayout.tsx`, `VideosLayout.tsx`,
`media/MediaLayout.tsx`.

### `ArtBillboard` - `src/components/shared/ArtBillboard.tsx`

Generic editorial billboard for app hubs: up to six featured items in an auto-rotating
scroll-snap carousel, each slide's art dissolving into its own extracted accent via
`BlendedHeroBackdrop`. App-neutral sibling of the Videos billboard and `media/MediaBillboard`
(those stay specialized). Items carry same-origin `art`, a `to`/`state` link or `onClick`,
and a pill label + icon. Used by the Podcasts Listen Now hub and the Book Store hub.

```ts
{ items: ArtBillboardItem[]; eyebrow: string; className?: string }
// ArtBillboardItem: { key, title, subtitle?, art, to?, state?, onClick?, pillLabel, PillIcon }
```

Sizing rule for ALL hub billboards (ArtBillboard, media/MediaBillboard, Music's
StationBillboard): desktop height is capped at `sm:h-64 lg:h-72 xl:h-80`, phones keep a
tall aspect ratio. A hub must show the hero plus roughly two rows of content below the
fold. Width-driven aspect ratios (21:6) are only acceptable beside a rail that narrows
the content column (the Videos hub); on rail-less hubs they balloon.

### `ViewToggle` - `src/components/shared/ViewToggle.tsx`

Pill-shaped card ⇄ list switch (`LayoutGrid` / `List` icons). Use anywhere a page offers both a grid and a list layout instead of hand-rolling the two-button group. Pair it with `useViewPreference(key, fallback)` (`src/hooks/useViewPreference.ts`) to persist the choice per-user in `user_preferences` (dotted key, e.g. `youtube.channel_view`) so it survives reloads and syncs across devices.

```ts
// ViewToggle
{ value: 'grid' | 'list'; onChange: (v: 'grid' | 'list') => void; className?: string }
// useViewPreference -> [view, setView]
useViewPreference(key: string, fallback?: 'grid' | 'list')
```

### Family audio components - `src/components/shared/FamilyAudioGuard.tsx` and siblings

The kids/family audio guardrail UX (backend: `lib/family/audioPolicy.ts`, admin surface:
Admin > Family Audio). Three pieces, all driven by `useFamilyAudio()`
(`src/hooks/useFamilyAudio.ts`, polls `GET /api/family-audio/me`):
- `FamilyAudioGuard` - mounted ONCE in `App.tsx` inside the player providers; stops
  music/live-radio/podcast playback when the profile's time budget or quiet hours gate
  closes, fires the one-time "5 minutes left" warning toast, and clamps player volume to
  the profile's cap. Renders nothing.
- `FamilyRemainingChip` - small remaining-audio-time pill for player bars (renders only
  when the profile has a daily budget). Used by `RadioMiniBar` and `PodcastPlayerBar`.
- `FamilyAudioBlockedCard` - friendly full-state card ("Audio time is done for today" /
  quiet hours) for media hubs; renders nothing while the gate is open, so pages mount it
  unconditionally. Used by the Music home and the Podcasts Listen Now page.

### Listening Together components - `src/components/shared/DevicesPopover.tsx` and siblings

Whole-home player control (backend: `lib/together/`, `routes/together.ts`; see
`docs/internal/subsystems.md` > Listening Together). One visible component and three
headless mount points:
- `DevicesPopover` - THE "play on another device" surface: lists every other live player
  session in the household, and picking one opens a compact remote (now-playing readout +
  seek + transport + volume) driving that session. Mounted in the music mini bar and the
  podcast player bar; do not hand-roll another remote.
- `TogetherPresence` / `TogetherRemoteReceiver` / `TogetherJamHost` - mounted ONCE each in
  `App.tsx` inside the player providers (beside `FamilyAudioGuard`). They advertise this
  session as a player device, execute inbound remote commands through the player contexts'
  public APIs, and feed the host's player from the Family Jam shared queue. All render nothing.

**Rule: a remote command must go through a player context's public API** (`RadioContext`,
`PodcastPlaybackContext`, or the media coordinator's `dispatchTransport`), never an audio
element or engine internals. Add a context method if one is missing, as `enqueueTrack` /
`upNextCount` (radio) and `setVolume` (podcast) were added for exactly this.

Music-scoped siblings: `components/music/JamBanner.tsx` (start/join/end, on the Music home
page) and `JamQueueSheet.tsx` (the shared queue with "added by" attribution + dnd reorder).

### `AiGeneratedBadge` - `src/components/shared/AiGeneratedBadge.tsx`

THE one label for AI-generated content (sparkle glyph + short honest text). Apple's
Generative-AI HIG is the reference: anything a model wrote or summarized must be marked so a
reader is never misled into thinking it is human-authored or verbatim source text. Use it on
podcast insights, briefing digests, notification summaries, camera digests, AI-authored
books/podcasts, and any new generated surface instead of hand-rolling a per-surface label.

```ts
{ label?: string; tone?: 'muted' | 'brand'; className?: string; title?: string }
```

`label` should say what produced the content ("Summarized by Loki", "Made with Imaging").
`title` carries an optional hover caveat (e.g. a summary-accuracy note). Never summarize
safety-relevant content (camera/security alerts) - show it verbatim, no badge, no rewrite.

---

### Toasts (app-wide) - `sonner`

Toasts are mounted globally via `AppToaster` (`src/components/shared/AppToaster.tsx`, rendered once in `App.tsx`, theme-synced to light/dark). To show transient feedback after a save or destructive action, call `toast.success(...)` / `toast.error(...)` from `sonner` anywhere. Do **not** build inline "Saving…/Saved" text for new code. Prefer toasts for success/error confirmation; keep optimistic UI updates as-is.

---

## Visual Language

The reference for "does this look right" is the app's own brand mark (`public/favicon.svg`,
rendered via `BrandMark`): a near-black rounded tile with ONE restrained diagonal accent
gradient on a precise mark. Build the rest of the UI toward that, not toward "more color."

- **Accent discipline.** `bg-brand`/`text-brand`/`border-brand`/`ring-brand` is the only accent
  for interactive UI - buttons, active states, focus rings, links. The brand mark's multi-stop
  gradient is for brand/hero moments only (`BrandMark`, onboarding hero panels). Never copy it
  onto a generic button or badge. Per-app registry gradients (`appCategories.ts`) are fine for
  sparse, larger identity moments (a breadcrumb crumb, one `PageHeader`/`AppRailHeader` tile, a
  hero banner), but in dense, repeated contexts (a stacked nav list, a grid of category cards)
  use `AppIconTile`'s `variant="flat"` (the app's single solid `color`) instead. A wall of
  differently-hued multi-stop gradients reads as a sticker sheet, not a curated nav rail.
- **Calm surfaces.** Default to `bg-card`/`bg-background`. Color is an accent, not wallpaper.
- **No emoji as UI.** Icons are lucide-react only, full stop. This includes status glyphs,
  presence indicators, and category icons, not just decorative icons. Emoji are fine inside
  natural-language body copy (e.g. a generated advice string) but never stand in for an icon
  component.
- **One state-handling idiom per concept.** `EmptyAppState` for empty states, `sonner`
  (`toast.success`/`toast.error`) for save/error feedback, `ConfirmDialog` for every destructive
  action, `cardVariants` (`surface`/`interactive`/`gradient`/`dashed`) for cards. These are not
  optional patterns among several, they are the only pattern. Do not hand-roll a "Saving.../
  Saved" label, a second confirm-button component, or a bespoke "nothing here" block.
- **Sanctioned dynamic-palette surfaces.** Art-derived accents (`ArtAccentScope`,
  `useArtPalette`, `UltraBlur`) are allowed only where one artwork dominates the surface:
  Videos = watch page, channel pages, home billboard. Music = players and station surfaces.
  Movies/Shows = hub billboard and detail pages. Podcasts = hub billboard, show hero, Now
  Playing, player bar. Books = hub billboard, book detail hero, audiobook player, never the
  reader views. Imaging = the canvas pane (an always-dark studio, tinted by the current
  result) and lightbox, not per history tile. Shopping = the buy box only. Everywhere
  else keeps the app's static accent. Never extract per-card in grids or lists.
- **No floating UI parked on top of content.** A persistent overlay (the companion, a mini
  player) defaults to a corner dock, not dead-center, so it never guarantees an overlap with
  whatever the page happens to render there.
- **Label AI-generated content, keep revert adjacent.** Any surface showing text a model wrote
  or summarized carries an `AiGeneratedBadge` (never a hand-rolled label), and any generated
  artifact keeps an Edit/Undo/Retry affordance next to it (chat has Regenerate; writing-tools
  edits keep an "Original" toggle; image results keep Retry). No generated artifact ships
  without an adjacent way to revert or retry it. Never summarize or rewrite safety-relevant
  content (camera/security alerts): show it verbatim. Prefer specific status text ("Scanning
  transcript…", image-gen step counts) over a bare spinner on any AI path.
- **No em dashes** in documentation, UI copy, code comments, or commit messages (see Writing
  Style above). This is the single most common violation found in an app-wide audit, more than
  any other rule here, so treat it as the canonical thing to check a diff against.

**Checking a diff against this:** run `bun run check:design-contract` (frontend/scripts, see
Minimum Testing Requirements) before calling frontend work done. It greps for the mechanical
violations (em dashes, hardcoded `violet-*`, `window.confirm`/`window.alert`) and is not a full
substitute for reading the diff against the rules above, but it catches regressions on exactly
the patterns that recur most.

---

## Mobile Design Contract

The app is installed as a full-screen PWA on iPhones (`black-translucent` status bar +
`viewport-fit=cover`), which means the web page renders under the clock/battery status bar and
the home indicator. The quality bar for phone layouts is the Netflix / Apple Music / YouTube
iOS apps: compact chrome, one content column, dense rails with a peek of the next card, and
nothing ever colliding with the system bars. Every rule here exists because we shipped the
opposite at least once.

### Safe areas: the shell owns them, pages never do

- `AppShell`'s right column has `pt-safe`; `MobileDock` has `pb-safe`; `SheetContent` pads its
  fixed sides. Utilities (`pt-safe`/`pb-safe`/`pl-safe`/`pr-safe`) are defined in `index.css`
  and are all 0 on desktop. A normal page component must NEVER think about the notch.
- The exception that must opt in: any `fixed` full-screen surface escapes the shell column and
  pads itself (`NowPlayingOverlay`, `ImmersivePlayer`, `PrivacyOverlay`, kiosk/display pages).
  If you build a new fixed overlay, add `pt-safe`/`pb-safe` to it or its own chrome.
- Anything pinned to the bottom of the viewport needs `pb-safe` (checker rule
  `fixed-bottom-no-pb-safe`). Anything floating above the bottom chrome offsets past
  `--bottom-chrome` (a CSS var the shell measures from the real media-bar + tab-bar
  stack via `useBottomChrome`; see `BackgroundSetupWidget`, the quick-ask sheet)
  instead of hardcoding a bar height or stacking a second bottom bar.
- **The bottom tab bar is ALWAYS visible on phones.** Every overlay - sheets, drawers,
  Spotlight, dim scrims, even the full music/immersive players - stops at
  `max-md:bottom-[var(--bottom-chrome,0px)]` instead of `inset-0`'s bottom (ui/sheet and
  ui/dialog overlays already do this). Never call `requestFullscreen` on a phone
  (`PlayerOverlayContext` gates it on `min-width: 768px`); non-route overlays that leave
  the bar tappable must close themselves on navigation (see `PlayerOverlayProvider`'s
  pathname effect and MobileDock's surfaces). Exactly ONE
  media mini-bar renders at a time (`MediaBarSlot` arbitrates music/live-radio/
  podcast/video and hides a bar on routes where its full player owns the screen);
  never mount a new persistent bar outside that slot. On phones every media bar
  renders the shared `CompactMediaBar` row (art + title + play + next + close, tap
  body = open full player); extra controls belong in the full player, not the bar.

### No accidental zoom, ever

- iOS Safari zooms the page when a focused input's computed font-size is under 16px. `ui/Input`
  and `ui/Textarea` are `text-base md:text-sm` for exactly this reason. Never use a raw
  `<input>`/`<textarea>` in app code (checker: `raw-input-element`) and never override a shared
  input back down with `text-sm`/`text-xs` without a `md:` guard (checker: `mobile-input-zoom`).
- `html` has `touch-action: manipulation` (kills double-tap-to-zoom; pinch still works) and
  `-webkit-text-size-adjust: 100%`. Do NOT "fix" zoom with `maximum-scale=1` /
  `user-scalable=no` in the viewport meta: it breaks pinch-zoom accessibility on Android and
  iOS ignores it anyway.

### Navigation: back always exists, rails are always reachable

- The phone model is two bars. Top bar (`MobileTopBar`) = THIS app: back chevron, app title
  (chevron opens the rail drawer), the app's action slots, gear = this app's settings. Bottom
  tab bar (`MobileDock`) = GLOBAL, four labeled tabs: Companion (screen-aware quick-ask sheet,
  never a second input echoing the reply), Home, Search (Spotlight; its empty state is the
  full app launcher grid), You (profile, notifications, global settings, admin, sign out).
  No unlabeled hamburgers anywhere; a many-section drawer trigger (Admin/global Settings) is
  a labeled "Sections" button.
- `MobileTopBar` shows a back chevron whenever router history can go back. It is the ONLY back
  affordance in the installed PWA, so never build a phone flow that traps the user (e.g. a
  full-screen overlay whose only exit is a hover control).
- A layout app (own left rail on desktop) MUST publish that rail through
  `useAppHeader({ rail })` so phones get it as the title-chevron drawer. If a screen is only
  reachable from a desktop rail, it does not exist on phones.
- App settings pages use `AppSettingsShell`: sections render as a horizontal `AppTabBar` pill
  row on phones (never a drawer for a handful of sections).
- Known gap to avoid making worse: inline rails render at `lg:` (1024px) but the mobile
  top bar/dock only exist below `md:` (768px), so 768-1024 tablets currently have neither.
  Don't add rail-only functionality without checking that band.

### Density: a phone is a 393px canvas

Reference behavior (Netflix/Apple Music): compact 44-48px top chrome, at most ONE horizontally
scrolling filter-chip row beneath it, then content.

- One primary column, `PageContainer` gutters (`px-4` on phones). No side-by-side panes.
- Horizontal rails show a peek of the next card: poster cards `w-36`-`w-44`, 16:9 video cards
  `w-64`-`w-72`. A full-viewport-width card is reserved for the single hero/billboard at the
  top of a page; a feed of them (one enormous card per row) is the #1 "designed on desktop"
  tell.
- Type scale on phones: page title <= `text-2xl`, section headers `text-lg`, card titles
  `text-sm`/`text-base`, metadata `text-xs text-muted-foreground`. Body copy stays 16px.
- Tap targets: >= 44px (`size-11`) for dock/floating controls, >= 40px (`size-10`) inside the
  48px top bar, and `gap-2` minimum between adjacent targets. Nothing interactive under 36px.
- Chips/filters: one row, `overflow-x-auto` with `overscroll-x-contain`, never wrapped to a
  second row; secondary switchers (view toggles, providers) go in the top bar slots or a sheet.

### Verifying phone layouts

Chrome DevTools at iPhone size is necessary but not sufficient: desktop Chromium reports
`env(safe-area-inset-*)` as 0, so a status-bar collision is invisible there. When touching the
shell, sheets, players, or any fixed chrome, screenshot at 393x852 with a simulated 59px status
bar / 34px home-indicator overlay and confirm nothing sits under either band (Playwright
snippet in `frontend/scripts/`, or ask the agent to reproduce it). Then run
`bun run check:design-contract` for the mechanical rules above.

---

## Code Conventions

- All styling via Tailwind utility classes - no CSS modules, no inline `style` props (except when a value is truly dynamic and can't be expressed as a class).
- Compose class names with `cn()` from `@/lib/cn`. Never concatenate class strings manually.
- TypeScript strict mode - no `any`, no type assertions without a comment explaining why.
- Component files export a single named export matching the filename (e.g. `RichOptionSelect.tsx` → `export function RichOptionSelect`).
- Use shadcn's `Badge` variants (`default`, `secondary`, `destructive`, `outline`, `info`) for status/label chips - do not build custom badge-like UI.
- Icons come from `lucide-react` only. Use the `size-*` Tailwind class (`size-4`, `size-5`) not `w-* h-*` pairs.

---

## Adding to `shared/`

Before adding a new shared component, check whether an existing one can be extended. When you do add one:
- Put it in `src/components/shared/`
- Export types alongside the component (e.g. `RichOption`, `RichOptionGroup`)
- Document it in this file under **Shared Component Catalog**

---

## App Store System

Apps and Extensions are surfaced in a single App Store (`/app-store`, `AppStorePage.tsx`). "Installed" means `enabled === true` in `toolGlobalConfig` (key `__enabled`). No separate consent ledger exists - install-time disclosure replaces it.

**Key concepts:**
- **Apps** (`offline: false`) - tools with dedicated page routes (weather, news, etc.)
- **Extensions** (`offline: true`) - chat-only tools with no page (calculator, datetime, etc.)
- **Built-ins** - page-only apps with no backend tool (Chat, Maps, Links, Images) - synthesized from `APP_GROUPS` in `appCategories.ts` and merged via `mergeApps()` in AppStorePage
- **Install flow (admin):** clicking "Get" opens `InstallDisclosureModal` which shows data sources, then calls `PUT /api/tools/:id/enabled { enabled: true }`
- **Uninstall flow (admin):** "Remove" calls `PUT /api/tools/:id/enabled { enabled: false }`
- **Request flow (non-admin):** "Request" posts to `POST /api/app-store/request` which creates an `install_request` notification targeting admins (`userId: null`)

**Routes:**
- `GET /api/tools` - list all tools with `enabled`, `offline`, `dataSources`
- `PUT /api/tools/:id/enabled` - admin toggle
- `POST /api/app-store/request` - non-admin install request

**Frontend:**
- `AppStorePage.tsx` - grid of cards, filter tabs (All/Installed/Apps/Extensions), search
- `InstallDisclosureModal.tsx` - data source disclosure before admin installs
- `TOOL_ROUTES` constant in AppStorePage maps tool IDs to page routes for "Open" button

**Uninstalled apps hidden everywhere:** `useInstalledTools.ts` hook + `isAppVisible()` helper used in `AllAppsPage`, `CategoriesPage`, `CategoryPage`, `HomePage` categories, and LeftSidebar pinned/recent.

---

## Notification System

**DB table:** `notifications` (migration 0017)
- `id`, `user_id` (nullable = admin-only), `type`, `payload` (JSON text), `read_at`, `created_at`
- Types: `install_request` | `install_complete` | `download_complete` | `system`
- `userId: null` = visible to all admins; `userId: <id>` = visible only to that user

**Routes:** `GET/PATCH/POST /api/notifications`, `GET /api/notifications/unread-count`, `POST /api/notifications/read-all`

**Frontend:**
- `useNotifications.ts` hook polls `/api/notifications/unread-count` every 30s
- Unread badge (red) on the user profile area in LeftSidebar
- Clicking the profile opens a dropdown showing recent notifications with mark-read and mark-all-read

---

## Home Layout System

Users can customize the home page canvas with widgets. Admins can set defaults and lock individual users.

**DB storage:** `userPreferences` table with keys:
- `home.layout` - per-user `HomeLayout` JSON
- `home.layout.locked` - boolean, prevents user from editing
- `app_settings` key `home.layout.default` - system-wide default

**Types:**
```ts
interface HomeWidget    { toolId: string; colSpan: 1 | 2 }
interface HomeRow       { id: string; cols: HomeWidget[] }
interface HomeLayoutHeader { weather: boolean; jokes: boolean; sports: boolean; locked: boolean }
interface HomeLayout    { header: HomeLayoutHeader; canvas: HomeRow[] }
```

**Routes:**
- `GET/PUT /api/home-layout` - current user's layout (GET migrates legacy `home.highlights` pref)
- `GET/PUT /api/home-layout/default` - admin: system default
- `GET/PUT /api/home-layout/users/:id` - admin: per-user layout + lock flag

**Frontend:**
- `useHomeLayout.ts` hook - fetches layout, exposes `save(layout)` and `locked`
- `HomePage.tsx` - header zone gated on `layout.header.*` flags; canvas zone below with dnd-kit row sorting in edit mode; widget picker modal
- Widget registry in `HomePage.tsx`: `weather`, `news`, `jokes`, `sports`, `on-this-day`, plus placeholder for any other tool
- Edit mode: pencil button (hidden when locked), drag handles, row remove, "Add widget" dashed button
- `AdminAppsTab.tsx` (Admin > Apps): install requests panel, app install toggles, default layout editor, per-user layout + lock editor

**Legacy migration:** On first `GET /api/home-layout` with no existing layout, the API reads `home.highlights` preferences (sports/jokes booleans) and seeds `header` from them.

---

## Coding System

`/coding` (`CodingPage.tsx`) is a real terminal (xterm.js) attached to a persistent
**tmux session per user**, wrapping a single managed **Claude Code CLI** (`claude`)
process, replaces the old OpenCode integration.

**Key files:**
- `backend/src/lib/claudeCode.ts` - installs `@anthropic-ai/claude-code` as a pinned
  npm dependency into its own managed runtime dir (`data/coding/claude-runtime`),
  version bumped deliberately, not on every install
- `backend/src/lib/codingSandboxUser.ts` - OS-level sandbox: a dedicated unprivileged
  OS user per household when supported (real filesystem/process isolation, not just
  app-level checks); unsupported on Windows or before install, falls back to a plain
  directory under `data/coding/users/<userId>` with no OS isolation (Claude Code's own
  interactive approval prompts are the only guard in that case)
- `backend/src/lib/codingServer.ts` - session/pane management: one `tmux` session named
  `coding` per user, spawns `claude` inside it; per-user `HOME` nested inside the
  workspace dir (`.home`) so config/skills/credentials never leak across household
  members; tmux split/kill for panes
- `backend/src/lib/codingPtySidecar.ts` + `backend/scripts/coding-pty-sidecar.ts` - the
  actual PTY attach runs in a small **Node sidecar** process, not the main Bun process
  (`node-pty`'s data-callback delivery is unreliable under Bun)
- `backend/src/routes/coding.ts` - `GET /terminal` (WebSocket) relays the browser's
  socket to the PTY sidecar's socket verbatim in both directions; `POST /pane/:action`
  issues tmux split/kill commands

**Model:** the `coding` catalog role resolves an Ollama-served local model (falls back
to `ornith:9b`), configurable via the `coding_model` app setting.

**Persistence is the point:** closing the browser tab or reloading only kills the
attach client, tmux (and `claude` inside it) keeps running server-side, so a project
picks back up exactly where it left off.

---

## Books & Reference System

Two plain homes for all offline/discoverable reading content, split by artifact type:
a book/textbook/manual is a **Book** (`/books`), a living wiki/encyclopedia/Q&A/video/
doc-site is **Reference** (`/reference`). No "ZIM"/"archive"/"content pack" jargon
surfaces to users; that's still the underlying kiwix mechanism for Reference.

**Books** (`backend/src/routes/books.ts`, `frontend/src/pages/books/`):
- Storefront across 4+ sources: Project Gutenberg, Standard Ebooks, Internet Archive,
  LibriVox (audiobooks), Open Library/Google Books metadata, custom self-hosted OPDS
  indexers (Calibre-Web, Kavita, COPS, etc. - `bookIndexers` table, admin-managed), plus
  user uploads and magazines
- Two-tier per-user library state on `bookLibrary.status`: `'saved'` (metadata only,
  no bytes on disk) vs the offline-download lifecycle `'pending' → 'downloading' →
  'ready'` (only `'ready'` has a local copy)
- `bookProgress` tracks per-user reading (`epubCfi`) or listening
  (`audioPositionSec`/`audioChapterIdx`) position; switching modes doesn't align position
- TTS-to-audiobook for any text book without a narrated source; multi-track
  (LibriVox-style) audiobooks stream per-chapter from `externalAudioUrl` instead of
  seeking a single shared file
- **AI book authoring** (`backend/src/routes/booksGenerate.ts`, `bookProjects` +
  `bookProjectChapters` tables): draft an original book from a premise (or continue/
  reshape an existing one) through a reviewed pipeline - story bible → sample chapter →
  per-chapter generation, with user approval gates at each stage. Kept out of the shared
  `books` catalog until approved end to end; `commitProjectToBook()` then materializes a
  real `books` row (`sourceType='ai-generated'`)

**Reference** (`frontend/src/pages/reference/ReferencePage.tsx`,
`backend/src/routes/archives.ts` / `adminArchives.ts`): all installed kiwix/ZIM
reference archives (Wikipedia, repair guides, medical references, etc.) plus the
Dictionary and Medical lookup tools (their pages reused as-is; `/medical` and
`/dictionary` redirect here). `ZimSource.bookCategory` (in `zimCatalog.ts`) is what
drives the Books/Reference split for admin-added packs; the underlying kiwix
download/serve plumbing is unchanged, only the tag and presentation moved.

---

## Canvas / Artifacts System

`/canvas` (and the in-chat canvas tray) is an editable side pane the companion writes
code, documents, or HTML into live, backed by `backend/src/routes/artifacts.ts` +
`backend/src/lib/artifacts/store.ts` + the `tools/canvas.ts` chat tool.

**DB tables:** `artifacts` (`type`: `'code' | 'document' | 'html'`, `currentContent`,
`pinned`, `archivedAt`) and `artifactVersions` (one immutable row per revision,
`author`: `'assistant' | 'user'`, optional human-readable `summary`).

**How it streams:** the companion opens a canvas via an `open_artifact` directive in
its turn, content streams into the pane token-by-token via an `artifact_token` SSE
event (same transport as chat streaming). A chat message can target an already-open
artifact for an edit-style follow-up (`chat.ts` tracks the open artifact per
conversation) - see `POST /api/artifacts/:id/edit` for the LLM edit pass over current
content.

**Export:** PDF export goes through the same headless Chromium instance that powers
the Reader archive engine (`system.ts` - install-heals if Chromium is missing).

---
