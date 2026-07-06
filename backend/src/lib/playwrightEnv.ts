// Pins Playwright's managed-browser directory under data/ for the WHOLE process.
//
// MUST be the first import in index.ts: playwright-core computes its registry
// directory from PLAYWRIGHT_BROWSERS_PATH when the playwright module itself loads,
// and setting the env var afterwards has no effect (verified — executablePath()
// keeps resolving to %LOCALAPPDATA%/ms-playwright). The module-scope `??=` in
// render.ts / chromiumInstall.ts runs after their own `import 'playwright'`
// statement has already loaded playwright, so on a fresh boot those were always
// too late: the install check looked in LOCALAPPDATA while `playwright install`
// wrote to data/bin/playwright, making chromium-render fail forever ("Chromium
// install failed" × 6, with a browser-probe popup storm on every retry).
//
// Deliberately imports nothing but node builtins so no other module can sneak
// a playwright import in ahead of this assignment.
import { resolve } from 'node:path'

process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(process.cwd(), '..', 'data', 'bin', 'playwright')
