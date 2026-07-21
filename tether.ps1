# =============================================================================
#  Brainstem tether -- bringing your browser brainstem onto this device.
#
#  One command that takes a browser-brainstem user to a full on-device
#  brainstem, keeping their workspace (agents, memories, soul) along the way.
#
#  What it does:
#    1. Runs the standard published installer, exactly as published, in a NEW
#       PowerShell window (the installer ends by running the server in the
#       foreground, so it must live in its own window).
#    2. Waits (bounded) for http://localhost:7071/health to answer.
#    3. Imports the newest brainstem-workspace-*.zip from your Downloads
#       folder (exported from the browser brainstem within the last 7 days).
#    4. Opens http://localhost:7071 in your default browser.
#
#  Guarantees: idempotent (safe to re-run), fail-soft (an import problem never
#  blocks the install), no admin rights needed, and it never reads, prints, or
#  copies token files -- the browser export contains no credentials, and you
#  sign in again on-device via GitHub.
#
#  PowerShell 5.1 compatible. ASCII only.
# =============================================================================

$ErrorActionPreference = 'Continue'

$BrainstemHome = Join-Path $env:USERPROFILE '.brainstem'
$BrainDir      = Join-Path $BrainstemHome 'src\rapp_brainstem'
$AgentsDir     = Join-Path $BrainDir 'agents'
$DataDir       = Join-Path $BrainDir '.brainstem_data'
$SoulPath      = Join-Path $BrainDir 'soul.md'
$HealthUrl     = 'http://localhost:7071/health'
$HomeUrl       = 'http://localhost:7071'
$InstallOneLiner = 'irm https://raw.githubusercontent.com/kody-w/rapp-installer/main/install.ps1 | iex'

function Test-Health {
    try {
        Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Get-DownloadsDir {
    # The real Downloads folder can be relocated; ask the shell's known-folder
    # registry entry first, then fall back to the default location.
    try {
        $reg = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders' -ErrorAction Stop
        $val = $reg.'{374DE290-123F-4565-9164-39C4925E467B}'
        if ($val) {
            $expanded = [Environment]::ExpandEnvironmentVariables($val)
            if (Test-Path $expanded) { return $expanded }
        }
    } catch {}
    return (Join-Path $env:USERPROFILE 'Downloads')
}

function Import-BrowserWorkspace {
    # Everything in here is best-effort: any failure prints a note and moves on.
    $downloads = Get-DownloadsDir
    $zip = $null
    try {
        $cutoff = (Get-Date).AddDays(-7)
        $zip = Get-ChildItem -Path $downloads -Filter 'brainstem-workspace-*.zip' -File -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -gt $cutoff } |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
    } catch {}

    if (-not $zip) {
        Write-Host "  No browser workspace zip found in Downloads -- starting fresh."
        Write-Host "  (In the browser brainstem, ask it to 'download my workspace' first if you"
        Write-Host "  want your agents to come along.)"
        return
    }

    Write-Host ("  Found browser workspace: " + $zip.Name)
    $tmp = Join-Path $env:TEMP ('brainstem-tether-' + [System.Guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null
        Expand-Archive -Path $zip.FullName -DestinationPath $tmp -Force -ErrorAction Stop

        # -- Validate the manifest ------------------------------------------------
        $wsFile = Join-Path $tmp 'workspace.json'
        $schemaOk = $false
        if (Test-Path $wsFile) {
            try {
                $ws = Get-Content -Raw -Path $wsFile | ConvertFrom-Json
                if ($ws.schema -eq 'rapp-workspace/1.0') { $schemaOk = $true }
            } catch {}
        }
        if (-not $schemaOk) {
            Write-Host "  [!] workspace.json is missing or not schema 'rapp-workspace/1.0'."
            Write-Host "      This does not look like a brainstem workspace export -- skipping import."
            return
        }

        if (-not (Test-Path $BrainDir)) {
            Write-Host ("  [!] Brainstem install not found at " + $BrainDir + " -- skipping import.")
            Write-Host "      Re-run this tether after the install succeeds; it is safe to run again."
            return
        }

        # -- Agents ---------------------------------------------------------------
        $imported = 0
        $overwritten = 0
        $srcAgents = Join-Path $tmp 'agents'
        if (Test-Path $srcAgents) {
            if (-not (Test-Path $AgentsDir)) {
                New-Item -ItemType Directory -Path $AgentsDir -Force | Out-Null
            }
            $agentFiles = @(Get-ChildItem -Path $srcAgents -Filter '*.py' -File -ErrorAction SilentlyContinue)
            foreach ($f in $agentFiles) {
                $name = $f.Name
                if ($name -eq 'basic_agent.py') {
                    Write-Host "    skip   basic_agent.py (never overwritten)"
                    continue
                }
                $dest = Join-Path $AgentsDir $name
                $existed = Test-Path $dest
                try {
                    Copy-Item -Path $f.FullName -Destination $dest -Force -ErrorAction Stop
                    $imported = $imported + 1
                    if ($existed) {
                        $overwritten = $overwritten + 1
                        Write-Host ("    update " + $name + " (overwrote the existing file)")
                    } else {
                        Write-Host ("    import " + $name)
                    }
                } catch {
                    Write-Host ("    [!] could not copy " + $name + ": " + $_.Exception.Message)
                }
            }
        }

        # -- Memories (.brainstem_data) ------------------------------------------
        $memImported = $false
        $srcData = Join-Path $tmp '.brainstem_data'
        if (Test-Path $srcData) {
            $dataFiles = @(Get-ChildItem -Path $srcData -Recurse -File -ErrorAction SilentlyContinue)
            foreach ($df in $dataFiles) {
                try {
                    $rel = $df.FullName.Substring($srcData.Length).TrimStart('\', '/')
                    $destPath = Join-Path $DataDir $rel
                    $destParent = Split-Path -Parent $destPath
                    if (-not (Test-Path $destParent)) {
                        New-Item -ItemType Directory -Path $destParent -Force | Out-Null
                    }
                    Copy-Item -Path $df.FullName -Destination $destPath -Force -ErrorAction Stop
                    $memImported = $true
                } catch {
                    Write-Host ("    [!] could not copy memory file " + $df.Name + ": " + $_.Exception.Message)
                }
            }
        }

        # -- Soul (never clobbered) ----------------------------------------------
        $soulNote = 'not present in the zip'
        $srcSoul = Join-Path $tmp 'soul.md'
        if (Test-Path $srcSoul) {
            $sidePath = Join-Path $BrainDir 'soul.from-browser.md'
            if (Test-Path $SoulPath) {
                $same = $false
                try {
                    $h1 = (Get-FileHash -Path $srcSoul -Algorithm SHA256).Hash
                    $h2 = (Get-FileHash -Path $SoulPath -Algorithm SHA256).Hash
                    if ($h1 -eq $h2) { $same = $true }
                } catch {}
                if ($same) {
                    $soulNote = 'identical to the installed soul.md -- nothing to do'
                } else {
                    try {
                        Copy-Item -Path $srcSoul -Destination $sidePath -Force -ErrorAction Stop
                        $soulNote = 'differs from the installed one -- saved as soul.from-browser.md'
                        Write-Host ""
                        Write-Host "    Your browser soul.md differs from the installed one."
                        Write-Host ("    Saved it next to it as: " + $sidePath)
                        Write-Host "    The installed soul.md was NOT changed. To adopt the browser version:"
                        Write-Host ("      Copy-Item '" + $sidePath + "' '" + $SoulPath + "' -Force")
                    } catch {
                        $soulNote = 'could not be saved (' + $_.Exception.Message + ')'
                    }
                }
            } else {
                try {
                    Copy-Item -Path $srcSoul -Destination $sidePath -Force -ErrorAction Stop
                    $soulNote = 'saved as soul.from-browser.md (no installed soul.md was found)'
                } catch {
                    $soulNote = 'could not be saved (' + $_.Exception.Message + ')'
                }
            }
        }

        # -- Summary --------------------------------------------------------------
        $memWord = 'no'
        if ($memImported) { $memWord = 'yes' }
        Write-Host ""
        Write-Host ("  Workspace import complete: " + $imported + " agent(s) imported (" + $overwritten + " overwrote existing files); memories imported: " + $memWord)
        Write-Host ("  soul.md: " + $soulNote)
    } catch {
        Write-Host ("  [!] Workspace import skipped due to an error: " + $_.Exception.Message)
        Write-Host "      The install itself is unaffected. Re-run this tether to try the import again."
    } finally {
        try { Remove-Item -Recurse -Force -Path $tmp -ErrorAction SilentlyContinue } catch {}
    }
}

# =============================================================================
#  Main
# =============================================================================

Write-Host ""
Write-Host "  =============================================================="
Write-Host "   Brainstem tether -- bringing your browser brainstem onto"
Write-Host "   this device. Your agents and memories come along; your"
Write-Host "   tokens never do (you will sign in again via GitHub here)."
Write-Host "  =============================================================="
Write-Host ""

# Remember whether an old server was already answering, so we can tell the
# difference between "the previous server" and "the freshly installed one"
# (the installer stops any old server on port 7071 before launching).
$wasUp = Test-Health

Write-Host "  Step 1/3  Starting the standard on-device installer in a NEW window..."
Write-Host "            (That window handles install, GitHub sign-in, and then runs"
Write-Host "            the server. Keep it open -- closing it stops the brainstem.)"
Write-Host ""
try {
    Start-Process -FilePath 'powershell.exe' -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -NoExit -Command ' + $InstallOneLiner) | Out-Null
} catch {
    Write-Host ("  [!] Could not open the installer window: " + $_.Exception.Message)
    Write-Host "      You can run the installer yourself in any PowerShell window:"
    Write-Host ("        " + $InstallOneLiner)
    Write-Host "      This tether will keep waiting in case a brainstem comes up."
}

Write-Host "  Step 2/3  Waiting for the install to finish and the server to answer..."
Write-Host "            (Watch the NEW window -- it may show a GitHub sign-in code.)"
Write-Host ""

$deadline = (Get-Date).AddMinutes(15)
$sawDown = $true
if ($wasUp) { $sawDown = $false }
$serverUp = $false
$lastNote = Get-Date
while ((Get-Date) -lt $deadline) {
    if (Test-Health) {
        if ($sawDown) {
            $serverUp = $true
            break
        }
        # An older server is still answering; the installer will restart it.
    } else {
        $sawDown = $true
    }
    if (((Get-Date) - $lastNote).TotalSeconds -ge 60) {
        Write-Host "            ...still waiting (check the installer window for progress or errors; Ctrl+C here to give up -- re-running this tether later is safe)"
        $lastNote = Get-Date
    }
    Start-Sleep -Seconds 3
}
if (-not $serverUp) {
    # Bounded wait is over; accept whatever is answering right now, if anything.
    $serverUp = Test-Health
}

Write-Host "  Step 3/3  Importing your browser workspace (if any)..."
Write-Host ""
Import-BrowserWorkspace
Write-Host ""

if ($serverUp) {
    Write-Host ("  Opening " + $HomeUrl + " in your browser...")
    try { Start-Process $HomeUrl | Out-Null } catch {
        Write-Host ("  [!] Could not open a browser automatically -- visit " + $HomeUrl + " yourself.")
    }
    Write-Host ""
    Write-Host "  Tethered. Your on-device brainstem is running (see the installer window)."
} else {
    Write-Host ("  [!] The server at " + $HomeUrl + " is not answering yet.")
    Write-Host "      Run 'brainstem' in a new terminal to start it, then open:"
    Write-Host ("        " + $HomeUrl)
    Write-Host "      If your workspace did not import above, re-run this tether afterwards --"
    Write-Host "      it is safe to run as many times as you like."
}
Write-Host ""
