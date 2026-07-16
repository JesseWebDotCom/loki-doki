# Spawn/probe helper for the Windows coding sandbox (see lib/codingSandboxUser.ts and
# CODING-SANDBOX-DESIGN-2026-07-16.md). Runs AS THE APP USER; starts a child process
# as the restricted `lokidoki-coding` user via .NET Process.Start with credentials —
# CreateProcessWithLogonW under the hood. Pure PowerShell 5.1 (.NET Framework): no
# native helper binary, no P/Invoke. Static file — it contains no secrets; the
# password is decrypted at runtime from the DPAPI(LocalMachine) blob, whose NTFS ACL
# (SYSTEM/Administrators/app-user read) is the real gate on who can use it.
#
# All parameters arrive via environment variables, never argv (argv is visible to
# other local processes; inherited env is not):
#   LOKIDOKI_SB_MODE        probe (wait, exit with child's code) | spawn (detach, print PID)
#   LOKIDOKI_SB_BLOB        path to the DPAPI credential blob
#   LOKIDOKI_SB_USER        sandbox account name
#   LOKIDOKI_SB_EXE         executable to run
#   LOKIDOKI_SB_ARGS        JSON array of arguments
#   LOKIDOKI_SB_CWD         working directory (must be accessible to the SANDBOX user)
#   LOKIDOKI_SB_ENV         JSON object of environment overrides for the child
#   LOKIDOKI_SB_CLEAN       '1' = start from a minimal system env instead of inheriting
#                           this process's (the backend's env carries real secrets that
#                           must never reach a process the sandbox user can inspect)
#   LOKIDOKI_SB_TIMEOUT_MS  probe mode: kill + exit 124 after this long

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

$blob = [System.IO.File]::ReadAllBytes($env:LOKIDOKI_SB_BLOB)
$pwBytes = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
$secure = New-Object System.Security.SecureString
foreach ($ch in [System.Text.Encoding]::UTF8.GetString($pwBytes).ToCharArray()) { $secure.AppendChar($ch) }

# .NET Framework has no ProcessStartInfo.ArgumentList — build the single Arguments
# string with standard Windows quoting (quote when needed; double trailing
# backslashes before a closing quote; backslash-escape embedded quotes).
function Quote-Arg([string]$a) {
  if ($a -notmatch '[\s"]' -and $a.Length -gt 0) { return $a }
  $escaped = $a -replace '(\\*)"', '$1$1\"'
  $escaped = $escaped -replace '(\\+)$', '$1$1'
  return '"' + $escaped + '"'
}

$argList = @()
if ($env:LOKIDOKI_SB_ARGS) { $argList = @(ConvertFrom-Json $env:LOKIDOKI_SB_ARGS) }

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $env:LOKIDOKI_SB_EXE
$psi.Arguments = (($argList | ForEach-Object { Quote-Arg $_ }) -join ' ')
$psi.UserName = $env:LOKIDOKI_SB_USER
$psi.Password = $secure
$psi.Domain = '.'
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
# Load (create on first run) the sandbox account's profile so HKCU and DPAPI work
# inside the sandbox; per-session HOME/USERPROFILE are still overridden by the caller.
$psi.LoadUserProfile = $true
if ($env:LOKIDOKI_SB_CWD) { $psi.WorkingDirectory = $env:LOKIDOKI_SB_CWD }
if ($env:LOKIDOKI_SB_CLEAN -eq '1') {
  $keep = @('SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','PATH','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE','SYSTEMDRIVE','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMDATA','ALLUSERSPROFILE')
  $names = @($psi.EnvironmentVariables.Keys) | ForEach-Object { [string]$_ }
  foreach ($n in $names) { if ($keep -notcontains $n.ToUpperInvariant()) { $psi.EnvironmentVariables.Remove($n) } }
}
if ($env:LOKIDOKI_SB_ENV) {
  $overrides = ConvertFrom-Json $env:LOKIDOKI_SB_ENV
  foreach ($p in $overrides.PSObject.Properties) { $psi.EnvironmentVariables[$p.Name] = [string]$p.Value }
}
# Never leak the runner's own parameters (this script's config) into the child.
foreach ($k in @('LOKIDOKI_SB_MODE','LOKIDOKI_SB_BLOB','LOKIDOKI_SB_USER','LOKIDOKI_SB_EXE','LOKIDOKI_SB_ARGS','LOKIDOKI_SB_CWD','LOKIDOKI_SB_ENV','LOKIDOKI_SB_TIMEOUT_MS')) {
  if ($psi.EnvironmentVariables.ContainsKey($k)) { $psi.EnvironmentVariables.Remove($k) }
}

$p = [System.Diagnostics.Process]::Start($psi)

if ($env:LOKIDOKI_SB_MODE -eq 'spawn') {
  # The child is a normal process, not tied to this PowerShell's lifetime — printing
  # the PID and exiting leaves it running (the backend adopts it via its health probe).
  Write-Output $p.Id
  exit 0
}

$timeoutMs = 30000
if ($env:LOKIDOKI_SB_TIMEOUT_MS) { $timeoutMs = [int]$env:LOKIDOKI_SB_TIMEOUT_MS }
if (-not $p.WaitForExit($timeoutMs)) {
  try { $p.Kill() } catch { }
  exit 124
}
exit $p.ExitCode
