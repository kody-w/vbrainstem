# RAPP Burrow (Windows) — smallest on-device footprint that lets the in-browser
# vBrainstem (GitHub Copilot) run on THIS machine. No brainstem, no VS Code, no pip.
#   irm https://kody-w.github.io/vbrainstem/burrow.ps1 | iex
$ErrorActionPreference = "Stop"

$dir = Join-Path $HOME ".rapp-burrow"
$src = "https://kody-w.github.io/vbrainstem/burrow.py"

$py = (Get-Command python -ErrorAction SilentlyContinue) `
  ?? (Get-Command python3 -ErrorAction SilentlyContinue) `
  ?? (Get-Command py -ErrorAction SilentlyContinue)

if (-not $py) {
  Write-Host "RAPP Burrow needs Python 3." -ForegroundColor Yellow
  Write-Host "  Install it: winget install -e --id Python.Python.3.12   (or from https://python.org)"
  Write-Host "  Then re-run:  irm $src.Replace('.py','.ps1') | iex"
  exit 1
}

New-Item -ItemType Directory -Force -Path $dir | Out-Null
Write-Host "Fetching burrow..."
Invoke-WebRequest -UseBasicParsing -Uri $src -OutFile (Join-Path $dir "burrow.py")

Write-Host "Starting burrow on this machine ($env:COMPUTERNAME)..."
& $py.Source (Join-Path $dir "burrow.py")
