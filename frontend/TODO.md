# Frontend TODOs

## Chunk Size Refactor

The two remaining large chunks (`index.js` ~667kB, shared vendor ~744kB)
can be reduced by lazy-loading heavy imports inside ChatPage:

1. **Lazy-load `MessageItem`** — it pulls in `react-markdown`, `remark-gfm`,
   and `remark-breaks` (~150–200kB). Messages render after page load, so a
   `React.lazy()` wrapper with a skeleton placeholder is viable.

2. **Lazy-load `CharacterFrame` / `RiggedDicebearAvatar`** — pulls in
   `@dicebear/core` and `@dicebear/collection` (~200–300kB). The avatar
   animates after the first assistant reply, so it can load on demand.

3. **Evaluate `lucide-react` tree-shaking** — imported across 35+ files.
   Confirm the bundler is only including used icons; if not, switch to
   explicit per-icon imports (`lucide-react/dist/esm/icons/send`).

After these changes the initial ChatPage bundle should drop to ~300kB.
