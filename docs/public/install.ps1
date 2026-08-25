# MaiPai Home installer for Windows.
# Usage:  irm https://getmaipai.github.io/home/install.ps1 | iex
$ErrorActionPreference = 'Stop'

$Dir = if ($env:MAIPAI_DIR) { $env:MAIPAI_DIR } else { Join-Path $HOME 'maipai-home' }
$Repo = 'https://github.com/getmaipai/home.git'

Write-Host ''
Write-Host '  Installing MaiPai Home...'
Write-Host ''

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host '  Please install git first (https://git-scm.com), then run this again.'
  exit 1
}

$Tag = (git ls-remote --tags --sort=-v:refname $Repo 'v*' | Select-Object -First 1) -replace '.*refs/tags/', '' -replace '\^\{\}', ''
if (-not $Tag) { Write-Host '  Could not find the latest release. Check your internet connection.'; exit 1 }

if (Test-Path (Join-Path $Dir '.git')) {
  Write-Host "  Found an existing install at $Dir, updating it to $Tag..."
  git -C $Dir fetch --tags -q origin
} else {
  Write-Host "  Downloading MaiPai Home $Tag into $Dir..."
  git clone -q $Repo $Dir
}
git -C $Dir checkout -q $Tag

Write-Host '  Starting MaiPai Home (first start downloads what it needs)...'
Set-Location $Dir
& .\run.ps1
