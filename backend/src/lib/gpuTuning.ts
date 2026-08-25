import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir, writeFile, rm, copyFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dataDir, downloadUrl } from '@/lib/download'
import { extractZip, findFileInTree } from '@/lib/platform'
import { detectHardware } from '@/lib/hwfit'

const execFileAsync = promisify(execFile)

// ── NVIDIA driver tuning: CUDA Sysmem Fallback Policy ─────────────────────────
// On Windows the NVIDIA driver silently spills VRAM over-commits into system RAM
// instead of erroring. On this app's workloads (SDXL sharing a card with an LLM,
// eGPUs over Thunderbolt) that spill turns a ~30s generation into minutes of
// 100%-util-at-low-wattage crawling with no error anywhere. Setting the driver's
// "CUDA - Sysmem Fallback Policy" to "Prefer No Sysmem Fallback" for python.exe
// makes over-commits fail fast (ComfyUI catches CUDA OOM and falls back to its
// own tiling/offload paths, which are far faster than driver-level spill).
//
// There is no supported CLI/registry knob for this — it lives in the driver's
// profile store (DRS), normally edited via NVIDIA Control Panel. NVIDIA Profile
// Inspector (MIT, github.com/Orbmu2k/nvidiaProfileInspector) can import a .nip
// profile from the command line, which is the only scriptable route.
//
// The profile matches by executable NAME (python.exe) — the driver store has no
// full-path matching — so it applies to every python.exe on the machine. For a
// CUDA python workload that's almost always the desired policy anyway; the
// Features UI copy discloses it.

const TOOL_DIR       = join(dataDir, 'bin', 'nvidia-profile-inspector')
const TOOL_EXE       = join(TOOL_DIR, 'nvidiaProfileInspector.exe')
const APPLIED_MARKER = join(TOOL_DIR, 'sysmem-fallback.applied')

// Pinned release (v3.0.2.1, ~433 KB). Bump deliberately; the tool talks straight
// to the driver, so "latest" is not automatically safer.
const INSPECTOR_URL = 'https://github.com/Orbmu2k/nvidiaProfileInspector/releases/download/v3.0.2.1/nvidiaProfileInspector.zip'

// SettingID 283962569 = 0x10ECECC9 ("CUDA - Sysmem Fallback Policy");
// value 1 = "Prefer No Sysmem Fallback". Verified against the driver docs and
// nvidiaProfileInspector issue #166. 'Executeables' is the real (misspelled)
// element name in the .nip schema — do not fix it.
const PROFILE_NIP = `<?xml version="1.0" encoding="utf-16"?>
<ArrayOfProfile>
  <Profile>
    <ProfileName>MaiPai Home - Python CUDA</ProfileName>
    <Executeables>
      <string>python.exe</string>
    </Executeables>
    <Settings>
      <ProfileSetting>
        <SettingNameInfo>CUDA - Sysmem Fallback Policy</SettingNameInfo>
        <SettingID>283962569</SettingID>
        <SettingValue>1</SettingValue>
        <ValueType>Dword</ValueType>
      </ProfileSetting>
    </Settings>
  </Profile>
</ArrayOfProfile>
`

/** Marker-file probe: the driver store can't be queried cheaply, so "applied once,
 *  successfully" is the honest signal we keep. Driver reinstalls can wipe the
 *  profile without touching the marker — re-run the feature from Admin → Features
 *  after a driver upgrade if generations start crawling again. */
export function isGpuTuningApplied(): boolean {
  return existsSync(APPLIED_MARKER)
}

export async function installGpuTuning(
  onStatus: (msg: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (process.platform !== 'win32') throw new Error('NVIDIA driver tuning is Windows-only.')
  const hw = await detectHardware()
  if (hw.gpuVendor !== 'nvidia' || hw.cudaDevices.length === 0) {
    throw new Error('No NVIDIA GPU detected — driver tuning does not apply to this machine.')
  }

  await mkdir(TOOL_DIR, { recursive: true })

  if (!existsSync(TOOL_EXE)) {
    onStatus('Downloading NVIDIA Profile Inspector…')
    const zipPath = join(TOOL_DIR, 'nvidiaProfileInspector.zip')
    await downloadUrl(INSPECTOR_URL, zipPath, () => {}, signal, { minBytes: 100_000 })
    onStatus('Extracting…')
    await extractZip(zipPath, TOOL_DIR)
    await rm(zipPath, { force: true })
    if (!existsSync(TOOL_EXE)) {
      // Some releases nest the exe in a folder inside the zip.
      const found = await findFileInTree(TOOL_DIR, 'nvidiaProfileInspector.exe')
      if (!found) throw new Error('nvidiaProfileInspector.exe not found in the downloaded archive.')
      await copyFile(found, TOOL_EXE)
    }
  }

  onStatus('Applying driver profile (approve the Windows admin prompt when it appears)…')
  const nipPath = join(TOOL_DIR, 'maipai-sysmem-fallback.nip')
  // .nip files are utf-16 with BOM (that's what the tool itself exports).
  await writeFile(nipPath, '\uFEFF' + PROFILE_NIP, { encoding: 'utf16le' })
  // The v3 exe manifests requireAdministrator, so a plain spawn fails EACCES (Win32
  // error 740) with no prompt. Start-Process -Verb RunAs raises the UAC consent dialog
  // on the machine's desktop; -Wait -PassThru surfaces the real exit code. Passing the
  // .nip path as the only argument imports silently and exits (verified against
  // v3.0.2.1: exit 0, profile applied, no UI left running).
  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$p = Start-Process -FilePath '${TOOL_EXE}' -ArgumentList '"${nipPath}"' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`,
    ], { timeout: 120_000, windowsHide: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.toLowerCase().includes('canceled')) {
      throw new Error('The Windows admin prompt was declined - driver tuning was not applied.')
    }
    throw new Error(`Driver profile import failed: ${msg}`)
  }

  await writeFile(APPLIED_MARKER, new Date().toISOString(), 'utf8')
  onStatus('Driver profile applied — takes effect on the next ComfyUI start.')
}
