# RAPP Burrow (Windows) — smallest on-device footprint that lets the in-browser
# vBrainstem (GitHub Copilot) run on THIS machine. No brainstem, no VS Code, no pip.
#   irm https://kody-w.github.io/vbrainstem/burrow.ps1 | iex
# Compatible with Windows PowerShell 5.1 (the default) and PowerShell 7+.
$ErrorActionPreference = "Stop"

$dir = Join-Path $HOME ".rapp-burrow"
$src = "https://kody-w.github.io/vbrainstem/burrow.py"

# Prefer the 'py' launcher, then python3/python (avoids the Microsoft Store stub).
$py = $null
foreach ($c in @("py", "python3", "python")) {
  $cmd = Get-Command $c -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { $py = $cmd.Source; break }
}

if (-not $py) {
  Write-Host "RAPP Burrow needs Python 3." -ForegroundColor Yellow
  Write-Host "  Install it:  winget install -e --id Python.Python.3.12   (or from https://python.org)"
  Write-Host "  Then re-run: irm https://kody-w.github.io/vbrainstem/burrow.ps1 | iex"
  return
}

New-Item -ItemType Directory -Force -Path $dir | Out-Null
Write-Host "Fetching burrow..."
Invoke-WebRequest -UseBasicParsing -Uri $src -OutFile (Join-Path $dir "burrow.py")

Write-Host "Starting burrow on this machine ($env:COMPUTERNAME)..."
& $py (Join-Path $dir "burrow.py")
