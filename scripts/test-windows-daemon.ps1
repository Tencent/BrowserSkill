#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateRange(1, 5)][int]$Repeat = 1,
    [switch]$Worker,
    [string]$ManifestPath
)
$ErrorActionPreference = 'Stop'

# This is a test host, never a production daemon launcher. WMI starts it outside
# the caller's Job; verify both identity and Job membership instead of assuming
# the CI runner permits CREATE_BREAKAWAY_FROM_JOB.
# https://learn.microsoft.com/windows/win32/procthread/job-objects
if ($Worker) {
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    $runDir = Split-Path -Parent $ManifestPath
    $results = @()
    $failure = $null
    try {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class DaemonTestHost {
    [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool inJob);
}
"@
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        if ($sid -ne $manifest.userSid) { throw 'Independent test host changed OS user' }
        $inJob = $false
        if (-not [DaemonTestHost]::IsProcessInJob([DaemonTestHost]::GetCurrentProcess(), [IntPtr]::Zero, [ref]$inJob)) {
            throw 'Could not query test host Job membership'
        }
        if ($inJob) { throw 'Independent test host is still in a Job; no success-path tests were run' }
        "userSid=$sid; inJob=$inJob" | Set-Content -LiteralPath "$runDir/host.txt"
        Set-Location -LiteralPath $manifest.workspace
        $env:CI = 'true' # Default-port cold startup must execute, never skip.
        if ($manifest.runnerTrackingId) { $env:RUNNER_TRACKING_ID = $manifest.runnerTrackingId }
        # Update tests compile stand-ins for broken releases.
        $env:RUSTC = $manifest.rustc
        for ($round = 1; $round -le $manifest.repeat; $round++) {
            foreach ($suite in $manifest.suites) {
                $name = "$($suite.name)-$round"
                $process = New-Object Diagnostics.Process
                $process.StartInfo.FileName = $suite.executable
                $process.StartInfo.Arguments = $suite.arguments -join ' '
                $process.StartInfo.UseShellExecute = $false
                $process.StartInfo.CreateNoWindow = $true
                $process.StartInfo.RedirectStandardOutput = $true
                $process.StartInfo.RedirectStandardError = $true
                # The suite's copies of bsk and the daemons they start live in
                # its own temporary directory, so a timeout stops exactly those.
                $suiteTemp = Join-Path $runDir "temp/$name"
                $null = New-Item -ItemType Directory -Path $suiteTemp -Force
                $suiteTemp = (Resolve-Path -LiteralPath $suiteTemp).Path.TrimEnd('\') + '\'
                $process.StartInfo.EnvironmentVariables['TEMP'] = $suiteTemp
                $process.StartInfo.EnvironmentVariables['TMP'] = $suiteTemp
                $exitCode = -1
                $errorText = $null
                $stdout = $null
                $stderr = $null
                $timedOut = $false
                $watch = [Diagnostics.Stopwatch]::StartNew()
                try {
                    if (-not $process.Start()) { throw 'Test process did not start' }
                    $stdout = $process.StandardOutput.ReadToEndAsync()
                    $stderr = $process.StandardError.ReadToEndAsync()
                    if (-not $process.WaitForExit($manifest.suiteSeconds * 1000)) {
                        $timedOut = $true
                        throw "Test process exceeded $($manifest.suiteSeconds) seconds"
                    }
                    $exitCode = $process.ExitCode
                    if (-not $stdout.Wait(5000) -or -not $stderr.Wait(5000)) { throw 'Test process exited without pipe EOF' }
                } catch {
                    $exitCode = -1
                    $errorText = $_.ToString()
                } finally {
                    try {
                        if (-not $process.HasExited) { $process.Kill(); $null = $process.WaitForExit(5000) }
                    } catch { }
                    if ($timedOut) {
                        # Daemons the tests started run outside the test's process
                        # tree; stop those running from this suite's copies.
                        Get-CimInstance Win32_Process | Where-Object {
                            $_.ExecutablePath -and $_.ExecutablePath.StartsWith($suiteTemp, [StringComparison]::OrdinalIgnoreCase)
                        } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
                    }
                    # Keep the logs, not the copies of bsk, for the artifact upload.
                    Get-ChildItem -LiteralPath $suiteTemp -Recurse -Filter '*.exe' -ErrorAction SilentlyContinue |
                        Remove-Item -Force -ErrorAction SilentlyContinue
                    # Keep what the suite printed, also after a timeout.
                    foreach ($stream in @(@{ task=$stdout; file="$runDir/$name.stdout.log" }, @{ task=$stderr; file="$runDir/$name.stderr.log" })) {
                        try {
                            if ($stream.task -and $stream.task.Wait(5000)) { $stream.task.Result | Set-Content -LiteralPath $stream.file -Encoding utf8 }
                        } catch { }
                    }
                    $process.Dispose()
                }
                $results += [pscustomobject]@{ name=$name; exitCode=$exitCode; seconds=$watch.Elapsed.TotalSeconds; error=$errorText }
                # Keep running independent suites after a failure so updater
                # coverage cannot be hidden by a startup regression.
            }
        }
    } catch { $failure = $_.ToString() }
    $report = [pscustomobject]@{ error=$failure; results=$results }
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath "$runDir/result.tmp" -Encoding utf8
    Move-Item -LiteralPath "$runDir/result.tmp" -Destination "$runDir/result.json"
    if ($failure -or @($results | Where-Object exitCode -ne 0).Count) { exit 1 }
    exit 0
}

$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$runDir = Join-Path $workspace ('target/windows-daemon-validation/' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $runDir -Force
Push-Location -LiteralPath $workspace
try {
    # Build in the normal runner environment; the WMI host needs no inherited
    # Cargo PATH, credentials or toolchain environment. Use Cargo's exact paths.
    $artifacts = @(& cargo test -p bsk --lib --test windows_daemon_start --test windows_update --test auto_update_handover --no-run --locked --message-format=json-render-diagnostics)
    if ($LASTEXITCODE -ne 0) { throw 'Could not build Windows lifecycle tests' }
    $tests = @{}
    foreach ($line in $artifacts) {
        $artifact = $line | ConvertFrom-Json
        if ($artifact.reason -eq 'compiler-artifact' -and $artifact.profile.test -and $artifact.executable) {
            if ($artifact.target.name -eq 'bsk' -and $artifact.target.kind -notcontains 'lib') { continue }
            $tests[$artifact.target.name] = $artifact.executable
        }
    }
    $suites = @(
        @{ name='startup'; executable=$tests['windows_daemon_start']; arguments=@('--test-threads=1','--nocapture') },
        @{ name='launcher-lifetime'; executable=$tests['bsk']; arguments=@('daemon::start::tests','--test-threads=1','--nocapture') },
        @{ name='update'; executable=$tests['windows_update']; arguments=@('--test-threads=1','--nocapture') },
        @{ name='update-handover'; executable=$tests['auto_update_handover']; arguments=@('--test-threads=1','--nocapture') }
    )
    foreach ($suite in $suites) {
        if (-not $suite.executable -or -not (Test-Path -LiteralPath $suite.executable)) { throw "Missing executable for $($suite.name)" }
    }
    $sysroot = (& rustc --print sysroot).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Could not locate rustc' }
    $rustc = Join-Path $sysroot 'bin/rustc.exe'
    if (-not (Test-Path -LiteralPath $rustc)) { throw "Missing $rustc" }
    # Update suites wait on 20-second handover deadlines and take several
    # minutes on slower machines.
    $suiteSeconds = 480
    $manifest = @{
        workspace=$workspace; repeat=$Repeat; suites=$suites; rustc=$rustc; suiteSeconds=$suiteSeconds
        userSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        runnerTrackingId=$env:RUNNER_TRACKING_ID
    }
    $manifestPath = Join-Path $runDir 'manifest.json'
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding utf8
    $powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $command = '"{0}" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{1}" -Worker -ManifestPath "{2}"' -f $powershell,$PSCommandPath,$manifestPath
    $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow=[uint16]0 }
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine=$command; ProcessStartupInformation=$startup; CurrentDirectory=$workspace }
    if ($created.ReturnValue -ne 0) { throw "WMI test host creation failed: $($created.ReturnValue)" }
    $workerProcess = $null
    try {
        $workerProcess = [Diagnostics.Process]::GetProcessById($created.ProcessId)
        $null = $workerProcess.Handle # Retain identity for timeout cleanup.
        # Every suite may use its whole budget, plus time to start the host.
        $deadline = [DateTime]::UtcNow.AddSeconds(($suites.Count * $suiteSeconds + 120) * $Repeat)
        while (-not $workerProcess.WaitForExit(1000)) {
            if ([DateTime]::UtcNow -ge $deadline) { throw 'Independent test host timed out' }
        }
        if (-not (Test-Path -LiteralPath "$runDir/result.json")) { throw 'Independent test host exited without a report' }
        if (Test-Path -LiteralPath "$runDir/host.txt") { Get-Content -LiteralPath "$runDir/host.txt" }
        Get-ChildItem -LiteralPath $runDir -Filter '*.log' | ForEach-Object { Write-Output $_.Name; Get-Content -LiteralPath $_.FullName }
        $report = Get-Content -LiteralPath "$runDir/result.json" -Raw | ConvertFrom-Json
        $report.results | Format-Table -AutoSize | Out-Host
        if ($report.error) { throw $report.error }
        if (@($report.results).Count -ne ($suites.Count * $Repeat)) { throw 'Not all lifecycle suites executed' }
        if (@($report.results | Where-Object exitCode -ne 0).Count) { throw "Lifecycle regression failed; logs: $runDir" }
        Write-Output "All lifecycle suites passed; logs: $runDir"
    } finally {
        if ($workerProcess) {
            if (-not $workerProcess.HasExited) { $workerProcess.Kill(); $null = $workerProcess.WaitForExit(5000) }
            $workerProcess.Dispose()
        }
    }
} finally { Pop-Location }
