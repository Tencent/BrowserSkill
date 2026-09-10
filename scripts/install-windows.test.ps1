#Requires -Version 5.1
param([string]$BskPath = (Join-Path $PSScriptRoot "../target/debug/bsk.exe"))
$ErrorActionPreference = "Stop"

# Load definitions, never Main: no downloads or changes to the real user PATH.
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
function Assert-Fails([scriptblock]$Action) {
    $failed = $false
    try { & $Action } catch { $failed = $true }
    if (-not $failed) { throw "expected failure" }
}

$dir = 'C:\Users\Alice\.local\bin'
foreach ($existing in @('', 'C:\WindowsApps', 'C:\A;C:\B')) {
    $script:UserPath = $existing
    Add-ToUserPath $dir
    $expected = if ($existing) { "$existing;$dir" } else { $dir }
    Assert-Equal $script:UserPath $expected
    Add-ToUserPath $dir
    Assert-Equal $script:UserPath $expected
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("bsk-install-test-" + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
$oldBskHome = $env:BSK_HOME
$oldAutoUpdate = $env:BSK_AUTO_UPDATE
$daemon = $null
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

    $env:BSK_HOME = Join-Path $root "home"
    $env:BSK_AUTO_UPDATE = "off"
    [IO.Directory]::CreateDirectory($env:BSK_HOME) | Out-Null
    $sourceDir = Join-Path $root "download"
    [IO.Directory]::CreateDirectory($sourceDir) | Out-Null
    $source = Join-Path $sourceDir "bsk.exe"
    [IO.File]::Copy((Resolve-Path -LiteralPath $BskPath).Path, $source)
    $targetDir = Join-Path $root "中文 space [x] & install"
    [IO.Directory]::CreateDirectory($targetDir) | Out-Null
    $target = Join-Path $targetDir "bsk.exe"
    Install-Binary $source $target
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

    # Refuse replacement when daemon identity cannot be verified.
    [IO.File]::WriteAllText($infoPath, 'invalid daemon metadata')
    $before = (Get-FileHash -LiteralPath $target).Hash
    Assert-Fails { Install-Binary $source $target }
    Assert-Equal (Get-FileHash -LiteralPath $target).Hash $before
    [IO.File]::Delete($infoPath)

    # A remaining lock must fail without truncation or staging debris.
    $lock = [IO.File]::Open($target, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try { Assert-Fails { Install-Binary $source $target } } finally { $lock.Dispose() }
    Assert-Equal (Get-FileHash -LiteralPath $target).Hash $before
    if (@(Get-ChildItem -LiteralPath $targetDir -Filter "*.install-*").Count) { throw "staging files leaked" }
    Write-Host "Windows installer regressions passed ($($PSVersionTable.PSVersion))"
}
catch {
    Write-Host ($_ | Out-String)
    Write-Host $_.ScriptStackTrace
    throw
}
finally {
    if ($daemon -and -not $daemon.HasExited) {
        Stop-Process -Id $daemon.Id -Force
        $daemon.WaitForExit(5000) | Out-Null
    }
    $env:BSK_HOME = $oldBskHome
    $env:BSK_AUTO_UPDATE = $oldAutoUpdate
    Remove-Item Env:BSK_TEST_RC -ErrorAction SilentlyContinue
    # Resolve and verify before recursive cleanup; only this fixture is removed.
    $resolvedRoot = [IO.Path]::GetFullPath($root)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolvedRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
        -not ([IO.Path]::GetFileName($resolvedRoot)).StartsWith('bsk-install-test-')) { throw "invalid cleanup path" }
    Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
}
