# Run ONCE as Administrator. Persistent CPU-priority floors/ceilings so remote sessions
# (RDP, TightVNC) always outrank background media encodes, no matter who spawned them.
#
# Why: 7/28/2026 incident — a 4K NVENC transcode respawn stampede (fixed in
# backend/src/lib/youtube/hlsTranscode.ts) left the box starved and eGPU driver faulting;
# VNC/RDP crawled while the local console stayed usable. The backend already spawns its
# encoders at below-normal priority, but that is per-spawn and best-effort. These IFEO
# PerfOptions are enforced by the kernel at process creation for EVERY instance of the
# image, including orphans and processes started before the backend gets a chance.
#
# CpuPriorityClass values: 1=Idle 2=Normal 3=High 5=BelowNormal 6=AboveNormal

$ErrorActionPreference = 'Stop'
$ifeo = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options'

$targets = @(
    @{ Exe = 'ffmpeg.exe';    Pri = 5 }  # every encode starts Below Normal
    @{ Exe = 'ffprobe.exe';   Pri = 5 }
    @{ Exe = 'tvnserver.exe'; Pri = 6 }  # TightVNC outranks Normal-priority load
)

foreach ($t in $targets) {
    $key = Join-Path $ifeo "$($t.Exe)\PerfOptions"
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name CpuPriorityClass -Value $t.Pri -Type DWord
    Write-Host "$($t.Exe): CpuPriorityClass=$($t.Pri)"
}

Write-Host "`nDone. Takes effect for newly started processes; restart tvnserver to apply now:"
Write-Host "  Restart-Service tvnserver"
