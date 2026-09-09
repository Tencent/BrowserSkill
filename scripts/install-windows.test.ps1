#Requires -Version 5.1
param(
    [string]$BskPath = (Join-Path $PSScriptRoot "../target/debug/bsk.exe"),
    [switch]$HelpersOnly
)
$ErrorActionPreference = "Stop"

# Load definitions without running Main. Registry PATH writes are isolated below.
$installer = Join-Path $PSScriptRoot "../install.ps1"
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($installer, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($statement in $ast.EndBlock.Statements) {
    if ($statement -is [System.Management.Automation.Language.FunctionDefinitionAst]) {
        $definition = $statement.Extent.Text
        if ($statement.Name -eq "Add-ToUserPath") {
            $definition = $definition.Replace('[Environment]::GetEnvironmentVariable("PATH", "User")', '$script:UserPath')
            $definition = $definition.Replace('[Environment]::SetEnvironmentVariable("PATH", $newUserPath, "User")', '$script:UserPath = $newUserPath')
        }
        Invoke-Expression $definition
    }
}
function Assert-Equal($Actual, $Expected) {
    if ($Actual -cne $Expected) { throw "expected [$Expected], got [$Actual]" }
}
function Assert-Fails([scriptblock]$Action, [string]$MessageContains) {
    $failed = $false
    try { & $Action } catch {
        $failed = $true
        if ($MessageContains -and -not $_.Exception.Message.Contains($MessageContains)) { throw }
    }
    if (-not $failed) { throw "expected failure" }
}

# Isolate the fatal-error stub and restore the real process environment.
& {
    function Write-Die([string]$Message) { throw $Message }
    $oldProcessArch = $env:PROCESSOR_ARCHITECTURE
    $oldNativeArch = $env:PROCESSOR_ARCHITEW6432
    try {
        $cases = @(
            @{ Process = 'AMD64'; Native = $null; Arch = 'x64'; Triple = 'x86_64-pc-windows-msvc' }
            @{ Process = 'ARM64'; Native = $null; Arch = 'arm64'; Triple = 'aarch64-pc-windows-msvc' }
            @{ Process = 'amd64'; Native = $null; Arch = 'x64'; Triple = 'x86_64-pc-windows-msvc' }
            @{ Process = 'x86'; Native = 'AMD64'; Arch = 'x64'; Triple = 'x86_64-pc-windows-msvc' }
            @{ Process = 'x86'; Native = 'ARM64'; Arch = 'arm64'; Triple = 'aarch64-pc-windows-msvc' }
            @{ Process = $null; Native = 'AMD64'; Arch = 'x64'; Triple = 'x86_64-pc-windows-msvc' }
            @{ Process = 'x86'; Native = $null; Error = 'unsupported architecture: x86 (x64 and ARM64 only)' }
            @{ Process = 'AMD64'; Native = 'IA64'; Error = 'unsupported architecture: IA64 (x64 and ARM64 only)' }
            @{ Process = $null; Native = $null; Error = 'could not detect Windows architecture: PROCESSOR_ARCHITEW6432 and PROCESSOR_ARCHITECTURE are empty' }
        )
        foreach ($case in $cases) {
            $env:PROCESSOR_ARCHITECTURE = $case.Process
            $env:PROCESSOR_ARCHITEW6432 = $case.Native
            if ($case.Error) {
                $message = $null
                try { Get-PlatformTriple | Out-Null } catch { $message = $_.Exception.Message }
                Assert-Equal $message $case.Error
            }
            else {
                $platform = Get-PlatformTriple
                Assert-Equal $platform.ArchId $case.Arch
                Assert-Equal $platform.TargetTriple $case.Triple
                Assert-Equal $platform.PlatformKey "windows-$($case.Arch)"
            }
        }
        Write-Host "Windows installer architecture regressions passed ($($PSVersionTable.PSVersion))"
    }
    finally {
        $env:PROCESSOR_ARCHITECTURE = $oldProcessArch
        $env:PROCESSOR_ARCHITEW6432 = $oldNativeArch
    }
}
$dir = 'C:\Users\Alice\.local\bin'
$pathCases = @(
    @{ Existing = ''; Expected = $dir }
    @{ Existing = 'C:\WindowsApps'; Expected = "$dir;C:\WindowsApps" }
    @{ Existing = 'C:\A;C:\B'; Expected = "$dir;C:\A;C:\B" }
    @{ Existing = "C:\old-bsk;$dir;C:\B;$($dir.ToUpperInvariant())"; Expected = "$dir;C:\old-bsk;C:\B" }
)
$oldPath = $env:PATH
try {
    foreach ($case in $pathCases) {
        $script:UserPath = $case.Existing
        $env:PATH = $case.Existing
        foreach ($attempt in 1..2) {
            Add-ToUserPath $dir
            Add-ToSessionPath $dir
            Assert-Equal $script:UserPath $case.Expected
            Assert-Equal $env:PATH $case.Expected
        }
    }
} finally { $env:PATH = $oldPath }
if ($HelpersOnly) {
    Write-Host "Windows installer helper regressions passed ($($PSVersionTable.PSVersion))"
    return
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("bsk-install-test-" + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
$oldBskHome = $env:BSK_HOME
$oldAutoUpdate = $env:BSK_AUTO_UPDATE
$oldVersion = $env:BSK_VERSION
$oldProcessArch = $env:PROCESSOR_ARCHITECTURE
$oldNativeArch = $env:PROCESSOR_ARCHITEW6432
$daemon = $null
$script:DownloadServer = $null
try {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $bashRc = Join-Path $root ".bashrc"
    $existing = "# existing 中文 configuration" + [char]10
    [IO.File]::WriteAllText($bashRc, $existing, $utf8)
    $special = 'C:\Users\张三 space $HOME $(echo unsafe) ! & [x] O''Brien\.local\bin'
    Add-ToBashProfile $special $bashRc
    $first = [IO.File]::ReadAllText($bashRc)
    if (-not $first.StartsWith($existing)) { throw "existing bashrc content changed" }
    if (-not $first.Contains('张三')) { throw "Unicode path was lost" }
    Add-ToBashProfile $special $bashRc
    Assert-Equal ([IO.File]::ReadAllText($bashRc)) $first
    $bytes = [IO.File]::ReadAllBytes($bashRc)
    if ($bytes[0] -eq 0xEF) { throw "unexpected UTF-8 BOM" }

    $bash = [IO.Path]::GetFullPath((Join-Path (Split-Path (Get-Command git).Source -Parent) "../bin/bash.exe"))
    if (-not (Test-Path -LiteralPath $bash)) { throw "Git Bash is required for quoting regression" }
    $env:BSK_TEST_RC = $bashRc
    $probe = Join-Path $root 'probe.sh'
    [IO.File]::WriteAllText($probe, 'source "$BSK_TEST_RC"; printf "%s\n" "${PATH%%:*}"', $utf8)
    $actual = & $bash --noprofile --norc $probe
    if ($LASTEXITCODE -ne 0) { throw "Git Bash failed" }
    Assert-Equal $actual ('/c' + $special.Substring(2).Replace('\', '/'))

    $env:BSK_HOME = Join-Path $root "home [state]"
    $env:BSK_AUTO_UPDATE = "off"
    [IO.Directory]::CreateDirectory($env:BSK_HOME) | Out-Null
    $sourceDir = Join-Path $root "download"
    [IO.Directory]::CreateDirectory($sourceDir) | Out-Null
    $source = Join-Path $sourceDir "bsk.exe"
    [IO.File]::Copy((Resolve-Path -LiteralPath $BskPath).Path, $source)
    $targetDir = Join-Path $root "中文 space [x] & install"
    [IO.Directory]::CreateDirectory($targetDir) | Out-Null
    $target = Join-Path $targetDir "bsk.exe"
    $firstInstallOutput = Install-Binary $source $target 6>&1 | Out-String
    if ($firstInstallOutput -match 'daemon will restart') { throw 'fresh install reported a daemon restart' }
    Assert-Equal (Get-FileHash -LiteralPath $target).Hash (Get-FileHash -LiteralPath $source).Hash

    $daemon = Start-Process -FilePath $target -ArgumentList @('daemon', 'start', '--foreground', '--port', '0') -WindowStyle Hidden -PassThru
    $infoPath = Join-Path $env:BSK_HOME "daemon.json"
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while (-not [IO.File]::Exists($infoPath)) {
        if ($daemon.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw "daemon failed to start" }
        Start-Sleep -Milliseconds 50
    }
    # PE overlays distinguish old/new executables without another build.
    $stream = [IO.File]::OpenWrite($source)
    try {
        $stream.Seek(0, [IO.SeekOrigin]::End) | Out-Null
        $marker = $utf8.GetBytes("installer replacement regression")
        $stream.Write($marker, 0, $marker.Length)
    } finally { $stream.Dispose() }
    Install-Binary $source $target
    if (-not $daemon.WaitForExit(5000)) { throw "old daemon still running" }
    Assert-Equal (Get-FileHash -LiteralPath $target).Hash (Get-FileHash -LiteralPath $source).Hash
    & $target --version
    if ($LASTEXITCODE -ne 0) { throw "replacement is not executable" }

    # Installing into a new directory must also stop a daemon from the old one.
    $newTargetDir = Join-Path $root "new install"
    [IO.Directory]::CreateDirectory($newTargetDir) | Out-Null
    $newTarget = Join-Path $newTargetDir "bsk.exe"
    $before = (Get-FileHash -LiteralPath $target).Hash
    $daemon = Start-Process -FilePath $target -ArgumentList @('daemon', 'start', '--foreground', '--port', '0') -WindowStyle Hidden -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while (-not [IO.File]::Exists($infoPath)) {
        if ($daemon.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw "old-directory daemon failed to start" }
        Start-Sleep -Milliseconds 50
    }
    Install-Binary $source $newTarget
    if (-not $daemon.WaitForExit(5000)) { throw "new-directory install left the old daemon running" }
    Assert-Equal (Get-FileHash -LiteralPath $target).Hash $before
    Assert-Equal (Get-FileHash -LiteralPath $newTarget).Hash (Get-FileHash -LiteralPath $source).Hash
    & $newTarget --version
    if ($LASTEXITCODE -ne 0) { throw "new-directory installation is not executable" }
    if (@(Get-ChildItem -LiteralPath $newTargetDir -Filter "*.install-*").Count) { throw "new-directory staging files leaked" }

    # Refuse replacement when daemon identity cannot be verified.
    [IO.File]::WriteAllText($infoPath, 'invalid daemon metadata')
    $before = (Get-FileHash -LiteralPath $target).Hash
    Assert-Fails { Install-Binary $source $target } -MessageContains $infoPath
    Assert-Equal (Get-FileHash -LiteralPath $target).Hash $before

    # A failed stop must also prevent installation to a previously empty target.
    $blockedTarget = Join-Path $newTargetDir "blocked.exe"
    Assert-Fails { Install-Binary $source $blockedTarget } -MessageContains $infoPath
    if (Test-Path -LiteralPath $blockedTarget) { throw "failed stop created an installation" }
    if (@(Get-ChildItem -LiteralPath $newTargetDir -Filter "*.install-*").Count) { throw "failed stop leaked staging files" }
    Assert-Equal ([IO.File]::ReadAllText($infoPath)) 'invalid daemon metadata'
    # Following the reported recovery path must allow the same installation to succeed.
    [IO.File]::Delete($infoPath)
    Install-Binary $source $blockedTarget
    Assert-Equal (Get-FileHash -LiteralPath $blockedTarget).Hash (Get-FileHash -LiteralPath $source).Hash

    # A remaining lock must fail without truncation or staging debris.
    $lock = [IO.File]::Open($target, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try { Assert-Fails { Install-Binary $source $target } } finally { $lock.Dispose() }
    Assert-Equal (Get-FileHash -LiteralPath $target).Hash $before
    if (@(Get-ChildItem -LiteralPath $targetDir -Filter "*.install-*").Count) { throw "staging files leaked" }

    # Exercise Main with real ZIPs/executables, isolating network and user state.
    & {
        $fixtureTemp = Join-Path $root 'temp [literal]'
        [IO.Directory]::CreateDirectory($fixtureTemp) | Out-Null
        $mainDefinition = ($ast.EndBlock.Statements | Where-Object {
            $_ -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -eq 'Main'
        }).Extent.Text.Replace('[System.IO.Path]::GetTempPath()', '$fixtureTemp')
        Invoke-Expression $mainDefinition
        function Write-Die([string]$Message) { throw $Message }
        $bashProfile = (Get-Command Add-ToBashProfile).ScriptBlock
        function Add-ToBashProfile([string]$Dir) {
            & $bashProfile $Dir (Join-Path $root 'flow.bashrc')
        }
        $fixtureArchive = Join-Path $root 'release.zip'
        Compress-Archive -LiteralPath $source -DestinationPath $fixtureArchive -CompressionLevel Fastest
        # Serve the ZIP over loopback HTTP. Only the URL is redirected below;
        # Invoke-WebRequest and the installer's disk writes remain real.
        $script:DownloadServer = Start-Job -ArgumentList $fixtureArchive -ScriptBlock {
            param($Archive)
            $ErrorActionPreference = 'Stop'
            $body = [IO.File]::ReadAllBytes($Archive)
            $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
            try {
                $listener.Start()
                Write-Output $listener.LocalEndpoint.Port
                while ($true) {
                    if (-not $listener.Pending()) { Start-Sleep -Milliseconds 50; continue }
                    $client = $listener.AcceptTcpClient()
                    try {
                        $stream = $client.GetStream()
                        $stream.ReadTimeout = 5000
                        $stream.WriteTimeout = 5000
                        $reader = [IO.StreamReader]::new($stream)
                        while (($line = $reader.ReadLine()) -and $line.Length) { }
                        $header = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 200 OK`r`nContent-Type: application/octet-stream`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n")
                        $stream.Write($header, 0, $header.Length)
                        $stream.Write($body, 0, $body.Length)
                    } finally { $client.Dispose() }
                }
            } finally { $listener.Stop() }
        }
        $serverPort = $null
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        while (-not $serverPort) {
            $serverPort = Receive-Job $script:DownloadServer
            if ($script:DownloadServer.State -ne 'Running' -or [DateTime]::UtcNow -gt $deadline) {
                throw 'download fixture failed to start'
            }
            if (-not $serverPort) { Start-Sleep -Milliseconds 50 }
        }
        $asset = @{ sha256 = (Get-FileHash -LiteralPath $fixtureArchive).Hash }
        $fixtureManifest = @{ version = '9.8.7'; assets = @{ 'windows-x64' = $asset } }
        $downloads = New-Object 'System.Collections.Generic.List[string]'
        function Invoke-RestMethod([string]$Uri) {
            if (-not $fixtureManifest) { throw 'fixture manifest unavailable' }
            return $fixtureManifest
        }
        function Invoke-WebRequest {
            [CmdletBinding()]
            param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
            $downloads.Add($Uri)
            $PSBoundParameters['Uri'] = "http://127.0.0.1:$serverPort/release.zip"
            Microsoft.PowerShell.Utility\Invoke-WebRequest @PSBoundParameters -TimeoutSec 15
        }
        $GitHub = 'https://example.invalid/fixture'
        $InstallDir = Join-Path $root 'installed [literal]'
        $installed = Join-Path $InstallDir 'bsk.exe'
        $env:BSK_VERSION = $null
        $env:PROCESSOR_ARCHITECTURE = 'AMD64'
        $env:PROCESSOR_ARCHITEW6432 = $null
        $script:UserPath = "$targetDir;$InstallDir;$($InstallDir.ToUpperInvariant())"
        $env:PATH = "$targetDir;$InstallDir;$oldPath"
        Assert-Equal (Get-Command bsk).Source $target
        $installOutput = Main 6>&1 | Out-String
        if ($installOutput -notmatch 'current session only' -or
            $installOutput -notmatch 'Machine PATH' -or $installOutput -notmatch 'Get-Command bsk -All') {
            throw 'install did not explain PATH verification in a new terminal'
        }
        Assert-Equal $downloads.Count 1
        Assert-Equal (Get-Command bsk).Source $installed
        Assert-Equal $script:UserPath "$InstallDir;$targetDir"
        Assert-Equal (Get-FileHash -LiteralPath $installed).Hash (Get-FileHash -LiteralPath $source).Hash
        Assert-Equal @(Get-ChildItem -LiteralPath $fixtureTemp -Force).Count 0

        # ARM64 must be listed in the manifest before any archive is requested.
        $env:PROCESSOR_ARCHITECTURE = 'ARM64'
        $downloads.Clear()
        $message = $null
        try { Main } catch { $message = $_.Exception.Message }
        Assert-Equal $message 'version.json does not list a Windows ARM64 package for bsk 9.8.7'
        Assert-Equal $downloads.Count 0
        $env:BSK_VERSION = '9.8.7'
        $fixtureManifest = $null
        $message = $null
        try { Main } catch { $message = $_.Exception.Message }
        Assert-Equal $message 'version.json does not list a Windows ARM64 package for bsk 9.8.7'
        Assert-Equal $downloads.Count 0

        # Keep pinned x64 installs compatible with older releases without manifests.
        $env:PROCESSOR_ARCHITECTURE = 'AMD64'
        Main
        Assert-Equal $downloads.Count 1
        Assert-Equal @(Get-ChildItem -LiteralPath $fixtureTemp -Force).Count 0

        # A listed ARM64 archive remains selectable (the fixture uses the host EXE).
        $fixtureManifest = @{ version = '9.8.7'; assets = @{ 'windows-arm64' = $asset } }
        $env:PROCESSOR_ARCHITECTURE = 'ARM64'
        Main
        Assert-Equal $downloads[$downloads.Count - 1] "$GitHub/releases/download/cli-v9.8.7/bsk-v9.8.7-aarch64-pc-windows-msvc.zip"

        # A checksum failure must clean the bracketed temp path and preserve the install.
        $before = (Get-FileHash -LiteralPath $installed).Hash
        $fixtureManifest.assets['windows-arm64'] = @{ sha256 = '0' * 64 }
        Assert-Fails { Main }
        Assert-Equal (Get-FileHash -LiteralPath $installed).Hash $before
        Assert-Equal @(Get-ChildItem -LiteralPath $fixtureTemp -Force).Count 0
    }
    Write-Host "Windows installer regressions passed ($($PSVersionTable.PSVersion))"
}
catch {
    Write-Host ($_ | Out-String)
    Write-Host $_.ScriptStackTrace
    throw
}
finally {
    if ($script:DownloadServer) {
        Stop-Job $script:DownloadServer
        Remove-Job $script:DownloadServer
    }
    if ($daemon -and -not $daemon.HasExited) {
        Stop-Process -Id $daemon.Id -Force
        $daemon.WaitForExit(5000) | Out-Null
    }
    $env:BSK_HOME = $oldBskHome
    $env:BSK_AUTO_UPDATE = $oldAutoUpdate
    $env:BSK_VERSION = $oldVersion
    $env:PROCESSOR_ARCHITECTURE = $oldProcessArch
    $env:PROCESSOR_ARCHITEW6432 = $oldNativeArch
    $env:PATH = $oldPath
    Remove-Item Env:BSK_TEST_RC -ErrorAction SilentlyContinue
    # Resolve and verify before recursive cleanup; only this fixture is removed.
    $resolvedRoot = [IO.Path]::GetFullPath($root)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolvedRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
        -not ([IO.Path]::GetFileName($resolvedRoot)).StartsWith('bsk-install-test-')) { throw "invalid cleanup path" }
    Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
}
