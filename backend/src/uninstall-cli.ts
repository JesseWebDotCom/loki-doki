// Standalone CLI entry point — called by run.sh --uninstall.
// Runs the same teardown as Admin → Settings → Uninstall and streams
// human-readable progress to stdout.

import { runUninstall } from './lib/uninstall'
import type { UninstallEmit, UninstallStatus } from './lib/uninstall'

const ICONS: Record<UninstallStatus, string> = {
  running: '→',
  ok:      '✓',
  warn:    '⚠',
  error:   '✗',
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const emit: UninstallEmit = ((event: string, data: any) => {
  if (event === 'step') {
    const icon = ICONS[data.status as UninstallStatus] ?? '→'
    const detail = data.detail ? `  (${data.detail})` : ''
    console.log(`  ${icon}  ${data.label}${detail}`)
  }
  // progress events are silent — the step events are enough for CLI output
}) as UninstallEmit

console.log('\nUninstalling MaiPai Home…\n')

try {
  await runUninstall(emit)
  console.log('\nDone. You can delete this folder to remove the remaining app files.\n')
  process.exit(0)
} catch (err) {
  console.error('\nUninstall failed:', err)
  process.exit(1)
}
