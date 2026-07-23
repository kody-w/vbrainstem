# RAPP Burrow (Windows) — smallest on-device footprint that lets the in-browser
# vBrainstem (GitHub Copilot) run on THIS machine. No brainstem, no VS Code, no pip.
# Auto-installs Python if missing (via winget, like the RAPP installer), then runs.
#   irm https://kody-w.github.io/vbrainstem/burrow.ps1 | iex
# Compatible with Windows PowerShell 5.1 (the default) and PowerShell 7+.
$ErrorActionPreference = "Stop"

$dir = Join-Path $HOME ".rapp-burrow"
$src = "https://kody-w.github.io/vbrainstem/burrow.py"

function Find-Python {
  foreach ($c in @("py", "python3", "python")) {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) {
      try { $v = & $cmd.Source --version 2>&1 } catch { $v = "" }
      if ($LASTEXITCODE -eq 0 -and "$v" -match "Python 3\.") { return $cmd.Source }
    }
  }
  foreach ($ver in @("Python312", "Python311", "Python313", "Python310")) {
    $direct = Join-Path $env:LOCALAPPDATA "Programs\Python\$ver\python.exe"
    if (Test-Path $direct) { return $direct }
  }
  return $null
}

$py = Find-Python
if (-not $py) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "Python 3 not found - installing it via winget (no admin needed)..." -ForegroundColor Yellow
    winget install --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements --silent --scope user 2>&1 | Out-Null
    # Refresh PATH for this session, and add the known install location.
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path", "User") + ";" + $env:Path
    $pyBase = Join-Path $env:LOCALAPPDATA "Programs\Python\Python312"
    if (Test-Path $pyBase) { $env:Path = "$pyBase;$pyBase\Scripts;$env:Path" }
    $py = Find-Python
  } else {
    Write-Host "Python 3 is required and winget isn't available." -ForegroundColor Yellow
    Write-Host "  Install Python from https://python.org (check 'Add to PATH'), then re-run:" -ForegroundColor Yellow
    Write-Host "  irm https://kody-w.github.io/vbrainstem/burrow.ps1 | iex"
    return
  }
}
if (-not $py) {
  Write-Host "Python was installed but isn't on PATH yet." -ForegroundColor Yellow
  Write-Host "Open a NEW terminal and re-run:  irm https://kody-w.github.io/vbrainstem/burrow.ps1 | iex"
  return
}

New-Item -ItemType Directory -Force -Path $dir | Out-Null
Write-Host "Fetching burrow..."
Invoke-WebRequest -UseBasicParsing -Uri $src -OutFile (Join-Path $dir "burrow.py")

# A venv so `cryptography` (for the twin's ECDSA identity) installs cleanly.
$venv = Join-Path $dir "venv"
$venvPy = Join-Path $venv "Scripts\python.exe"
if (-not (Test-Path $venvPy)) { & $py -m venv $venv 2>$null }
if (Test-Path $venvPy) { $run = $venvPy } else { $run = $py }
& $run -m pip install --quiet --disable-pip-version-check cryptography 2>$null

Write-Host "Starting burrow on this machine ($env:COMPUTERNAME)..."
& $run (Join-Path $dir "burrow.py")
