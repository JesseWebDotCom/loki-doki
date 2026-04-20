# Chunk 14 — Map theme follows site ThemeProvider by default

## Goal

After this chunk, switching the site theme (the existing
[ThemeProvider](../../../frontend/src/components/theme/ThemeProvider.tsx)
light/dark/system toggle) flips the map theme too, without the user
having to also touch the Settings → Maps radio. The per-map override
from chunk 11 still works (if the user explicitly picks Maps = Dark
while the site is in Light mode, Maps stays dark), but the *default*
source of truth becomes the site theme, not `matchMedia`.

Today `useMapTheme` at
[use-map-theme.ts:14](../../../frontend/src/pages/maps/use-map-theme.ts#L14)
resolves `'system'` via `window.matchMedia('(prefers-color-scheme: dark)')`
— which is the OS theme, NOT the app theme. If the site is set to
"Light" but macOS is in Dark mode, the map ignores the app choice and
stays dark. The user hit this on first test.

## Files

- `frontend/src/pages/maps/use-map-theme.ts` — change the
  `'system'` branch to read the site's ThemeProvider instead of
  `matchMedia`:
  - Import `useTheme` from
    `@/components/theme/ThemeProvider` (import the resolved
    palette, not the raw preference — the provider already folds
    `'system'` → `'light' | 'dark'` via its own matchMedia).
  - In `resolveTheme`, when preference is `'system'`, return
    `siteTheme` pulled from `useTheme().palette` (or whatever
    field the provider exposes as the resolved theme).
  - Remove the module-level `systemTheme()` helper +
    `MEDIA_QUERY` constant — `useTheme` already subscribes to
    matchMedia through the site provider; duplicating the
    subscription wastes listeners.
  - Keep the localStorage override + custom-event sync intact
    (so cross-tab propagation still works).
- `frontend/src/pages/maps/use-map-theme.test.ts` — rewrite the
  three existing tests:
  - `defaults to the site theme via ThemeProvider` — wrap
    `HookProbe` in a `<ThemeProvider defaultTheme="light">` and
    assert `theme === 'light'`.
  - `follows the site theme when it flips` — wrap in
    `<ThemeProvider>`, trigger a `setTheme('dark')` through the
    provider, assert the hook's `theme` flips.
  - `explicit map override wins over site theme` — set
    `localStorage.setItem('lokidoki.mapTheme', 'dark')` before
    render inside a light-provider, assert map stays dark.
- `frontend/src/components/settings/MapsSection.tsx` — copy-edit
  only: the radio label "System" now means "Follow site theme"
  since that's what it does. Change the visible label
  accordingly; no behavior change in this file.

Read-only:
- `frontend/src/components/theme/ThemeProvider.tsx` — confirm the
  exact export surface (likely `useTheme()` returning
  `{ theme, setTheme, resolvedTheme }` or similar) and use the
  resolved field, not the raw preference. If the provider already
  exposes a resolved `'light' | 'dark'` value, consume that
  directly instead of adding a second `matchMedia` layer.

## Actions

1. **Inspect `ThemeProvider.tsx`** once to confirm the hook
   signature. Pick the field that resolves `'system'` into a
   concrete `'light' | 'dark'` — that's the field `useMapTheme`
   should consume. If no such field exists, add a thin
   `useResolvedSiteTheme()` helper next to the provider.
2. **Rewrite `useMapTheme`** so `'system'` → site theme. The
   preference precedence stays: `localStorage override >
   'system' → site`. Drop the module-level matchMedia plumbing.
3. **Update tests** to the three cases above. Keep the existing
   localStorage stub shape the test already uses.
4. **Copy-edit the Settings radio** label for the `'system'`
   option to read "Follow site theme" (or similar short phrasing
   the design system already uses).
5. **Manual verification.** With dev server up:
   - Flip site theme to Light → the map's background turns
     light.
   - Flip site theme to Dark → the map flips dark.
   - Set Maps radio to "Dark" explicitly, then flip site to
     Light → map stays dark.
   - Set Maps radio back to "Follow site theme" → map flips
     with the site again.

## Verify

```
(cd frontend && npx vitest run src/pages/maps/use-map-theme.test.ts) \
  && (cd frontend && npx tsc -b) \
  && grep -q "useTheme" frontend/src/pages/maps/use-map-theme.ts \
  && ! grep -q "matchMedia" frontend/src/pages/maps/use-map-theme.ts \
  && echo "OK map theme sources from site ThemeProvider"
```

## Commit message

```
fix(maps): map theme follows site ThemeProvider, not OS matchMedia

useMapTheme resolved the 'system' preference against
window.matchMedia('(prefers-color-scheme: dark)') -- the OS theme --
so a user in Light site mode on a Dark OS saw a dark map even though
the app was in light mode. The site already has its own
ThemeProvider that folds 'system' into a resolved light/dark value
through the same matchMedia; the map should read from there so both
surfaces always agree.

Replace the map's matchMedia path with a useTheme() read from the
site provider. The explicit Maps-only override (localStorage
lokidoki.mapTheme = 'light' | 'dark') still wins when set. Relabel
the Maps radio 'System' option to 'Follow site theme' so the wording
matches what the option does.

Refs docs/roadmap/geocode-coverage/PLAN.md chunk 14.
```

## Deferrals

(Empty.)
