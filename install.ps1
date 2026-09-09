<#
.SYNOPSIS
install.ps1 — install the bsk CLI on Windows from GitHub Releases.

.DESCRIPTION
Downloads the latest (or pinned) bsk release for Windows x64 or ARM64,
extracts bsk.exe to a user-local directory, and adds it to PATH.

Usage:
  irm https://raw.githubusercontent.com/Tencent/BrowserSkill/main/install.ps1 | iex

Environment overrides:
  $env:BSK_REPO         GitHub owner/repo (default: Tencent/BrowserSkill)
  $env:BSK_VERSION      Pin CLI version (default: latest from version.json)
  $env:BSK_INSTALL_DIR  Install directory (default: $HOME\.local\bin)
#>

#Requires -Version 5.1

$ErrorActionPreference = "Stop"

$Repo = if ($env:BSK_REPO) { $env:BSK_REPO } else { "Tencent/BrowserSkill" }
$InstallDir = if ($env:BSK_INSTALL_DIR) { $env:BSK_INSTALL_DIR } else { Join-Path $HOME ".local\bin" }
$InstallDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InstallDir)
$GitHub = "https://github.com/${Repo}"

function Write-Log {
    param([string]$Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Die {
    param([string]$Message)
    Write-Host "error: $Message" -ForegroundColor Red
    exit 1
}

# ── Platform / architecture detection ─────────────────────────────────────────

function Get-PlatformTriple {
    # RuntimeInformation.ProcessArchitecture can be unavailable in Windows PowerShell 5.1.
    # WOW64 exposes the native architecture separately from the 32-bit process.
    $arch = $env:PROCESSOR_ARCHITEW6432
    if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
    if (-not $arch) {
        Write-Die "could not detect Windows architecture: PROCESSOR_ARCHITEW6432 and PROCESSOR_ARCHITECTURE are empty"
    }

    switch ($arch) {
        "AMD64" { $archId = "x64" }
        "ARM64" { $archId = "arm64" }
        default { Write-Die "unsupported architecture: $arch (x64 and ARM64 only)" }
    }

    $windowsArch = switch ($archId) {
        "x64"   { "x86_64-pc-windows-msvc" }
        "arm64" { "aarch64-pc-windows-msvc" }
    }

    return @{
        ArchId       = $archId
        TargetTriple = $windowsArch
        PlatformKey  = "windows-$archId"
    }
}

# ── Version resolution ────────────────────────────────────────────────────────

# ── PATH helpers ──────────────────────────────────────────────────────────────

function Add-ToUserPath {
    param([string]$Dir)

    $currentUserPath = @([Environment]::GetEnvironmentVariable("PATH", "User") -split ";" | Where-Object { $_ })

    if ($currentUserPath -contains $Dir) {
        Write-Log "$Dir is already in your user PATH"
        return
    }

    $newUserPath = ($currentUserPath + $Dir) -join ";"
    [Environment]::SetEnvironmentVariable("PATH", $newUserPath, "User")
    Write-Log "added ${Dir} to user PATH"
}

function Add-ToSessionPath {
    param([string]$Dir)

    $pathEntries = $env:PATH -split ";" | Where-Object { $_ }
    if ($pathEntries -contains $Dir) {
        return
    }

    $env:PATH = "$Dir;$env:PATH"
}

# ── Git Bash (bash environment) PATH helper ──────────────────────────────────

function Add-ToBashProfile {
    param([string]$Dir, [string]$BashRc = (Join-Path $HOME ".bashrc"))

    # Convert Windows path (e.g. C:\Users\foo\.local\bin) to Git-Bash Unix-style (/c/Users/foo/.local/bin)
    $unixPath = $Dir -replace '\\', '/'
    if ($unixPath -match '^([A-Z]):(.*)$') {
        $unixPath = '/' + $matches[1].ToLower() + $matches[2]
    }
    # Single-quote the literal directory; only the existing PATH is expanded.
    $shellQuote = "'" + [char]34 + "'" + [char]34 + "'"
    $quotedPath = "'" + $unixPath.Replace("'", $shellQuote) + "'"
    $exportLine = "export PATH=${quotedPath}:`"`$PATH`"  # bsk CLI"

    if (Test-Path -LiteralPath $BashRc) {
        $content = [System.IO.File]::ReadAllText($BashRc)
        if ($content.Contains($exportLine)) {
            Write-Log "$unixPath is already in ~/.bashrc"
            return
        }
    }

    # Explicit BOM-less UTF-8 also works in Windows PowerShell 5.1.
    [System.IO.File]::AppendAllText($BashRc, "`n$exportLine`n", (New-Object System.Text.UTF8Encoding($false)))
    Write-Log "added ${unixPath} to ~/.bashrc"
}

# ── Main ──────────────────────────────────────────────────────────────────────

# Stage on the destination volume before stopping the daemon. Never truncate
# the installed executable: failed replacement must leave it usable.
function Install-Binary {
    param([string]$Source, [string]$Target)

    $staged = "$Target.install-$([Guid]::NewGuid().ToString('N'))"
    try {
        [System.IO.File]::Copy($Source, $staged)
        # The running daemon may come from another installation directory.
        # Use the downloaded CLI: older versions have broken Windows liveness checks.
        # Stop verifies daemon identity and uses the current BSK_HOME.
        & $Source daemon stop
        if ($LASTEXITCODE -ne 0) { throw "could not stop bsk daemon; installation was not changed" }
        if ([System.IO.File]::Exists($Target)) {
            # PowerShell 5.1 converts $null to an empty path for string parameters.
            [System.IO.File]::Replace($staged, $Target, [NullString]::Value)
        }
        else {
            [System.IO.File]::Move($staged, $Target)
        }
        Write-Log "daemon will restart automatically on the next browser command"
    }
    finally {
        if ([System.IO.File]::Exists($staged)) { [System.IO.File]::Delete($staged) }
    }
}

function Main {
    $platform = Get-PlatformTriple

    if ($env:BSK_VERSION) {
        $version = $env:BSK_VERSION -replace '^v', ''
        $tag = "cli-v${version}"
        $manifestUrl = "${GitHub}/releases/download/${tag}/version.json"
        Write-Log "using pinned version ${version}"
        # Best-effort manifest fetch for the checksum (missing manifest
        # only skips verification; a mismatch is fatal below).
        try { $manifest = Invoke-RestMethod -Uri $manifestUrl } catch { $manifest = $null }
    }
    else {
        $manifestUrl = "${GitHub}/releases/latest/download/version.json"
        Write-Log "fetching latest version from ${manifestUrl}"
        $manifest = Invoke-RestMethod -Uri $manifestUrl
        $version = $manifest.version
        if (-not $version) { Write-Die "could not parse version from version.json" }
        $tag = "cli-v${version}"
        Write-Log "latest version is ${version}"
    }

    $archiveName = "bsk-v${version}-$($platform.TargetTriple).zip"
    $downloadUrl = "${GitHub}/releases/download/${tag}/${archiveName}"

    $expectedSha = $null
    $platformKey = $platform.PlatformKey
    if ($manifest -and $manifest.assets) {
        $expectedSha = $manifest.assets.$platformKey.sha256
    }
    if (-not $expectedSha) {
        if (-not $manifest) {
            Write-Log "warning: could not fetch version.json; skipping checksum verification"
        }
        else {
            Write-Log "warning: no checksum published for $($platform.PlatformKey); skipping checksum verification"
        }
    }

    $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

    try {
        $archivePath = Join-Path $tempDir $archiveName

        Write-Log "downloading ${downloadUrl}"
        Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath -UseBasicParsing -ErrorAction Stop

        if ($expectedSha) {
            Write-Log "verifying checksum"
            $actualSha = (Get-FileHash -Algorithm SHA256 -Path $archivePath).Hash
            if ($actualSha -ieq $expectedSha) {
                Write-Log "checksum OK"
            }
            else {
                Write-Die "checksum mismatch: expected $expectedSha, got $actualSha"
            }
        }

        Write-Log "extracting ${archiveName}"
        Expand-Archive -Path $archivePath -DestinationPath $tempDir -Force

        if (-not (Test-Path (Join-Path $tempDir "bsk.exe"))) {
            Write-Die "bsk.exe not found in archive"
        }

        if (-not (Test-Path $InstallDir)) {
            New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
        }

        Install-Binary -Source (Join-Path $tempDir "bsk.exe") -Target (Join-Path $InstallDir "bsk.exe")

        Write-Log "installed bsk to $InstallDir\bsk.exe"

        # Add to session PATH (current shell)
        Add-ToSessionPath $InstallDir

        # Add to user PATH (persistent, for PowerShell / cmd)
        Add-ToUserPath $InstallDir

        # Add to Git Bash PATH (persistent, for bash-based shells / agents)
        Add-ToBashProfile $InstallDir

        # Verify
        $bskPath = Join-Path $InstallDir "bsk.exe"
        & $bskPath --version
        if ($LASTEXITCODE -ne 0) { throw "installed bsk failed verification" }

        Write-Log "done"
        Write-Host ""
        Write-Host "Open a new terminal (PowerShell / Git Bash) for PATH changes to take full effect."
    }
    finally {
        Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
    }
}

Main
