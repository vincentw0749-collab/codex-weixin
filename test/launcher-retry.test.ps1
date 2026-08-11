$ErrorActionPreference = 'Stop'

$launcherPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\codex-weixin-launcher.ps1'
$testRoot = Join-Path $env:TEMP "codex-weixin-launcher-retry-$PID"
$attemptFile = Join-Path $testRoot 'attempts.txt'
$fakeNodePath = Join-Path $testRoot 'fake-node.ps1'
$fakeEntryPath = Join-Path $testRoot 'fake-entry.mjs'
$serviceUrl = 'http://127.0.0.1:18987'

New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
Set-Content -LiteralPath $fakeEntryPath -Value '// Test-only placeholder.'
Set-Content -LiteralPath $fakeNodePath -Value @'
param([string]$EntryPath)

$attempt = if (Test-Path -LiteralPath $env:LAUNCHER_TEST_ATTEMPT_FILE) {
    [int](Get-Content -Raw -LiteralPath $env:LAUNCHER_TEST_ATTEMPT_FILE)
} else {
    0
}
$attempt++
Set-Content -LiteralPath $env:LAUNCHER_TEST_ATTEMPT_FILE -Value $attempt

if ($attempt -lt 2) {
    exit 1
}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("$($env:LAUNCHER_TEST_SERVICE_URL)/")
$listener.Start()
while ($true) {
    $context = $listener.GetContext()
    $context.Response.StatusCode = 200
    $context.Response.Close()
}
'@

$env:LAUNCHER_TEST_ATTEMPT_FILE = $attemptFile
$env:LAUNCHER_TEST_SERVICE_URL = $serviceUrl

try {
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $launcherPath `
        -NoOpen `
        -NodePath $PSHOME\powershell.exe `
        -EntryPath $fakeEntryPath `
        -WorkingDirectory $testRoot `
        -ServiceUrl $serviceUrl `
        -NodeArguments "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$fakeNodePath`"" `
        -MaxStartupAttempts 2 `
        -StartupAttemptTimeoutSeconds 3 `
        -RetryDelaySeconds 0

    if ($LASTEXITCODE -ne 0) {
        throw "Launcher exited with code $LASTEXITCODE."
    }

    $attempts = [int](Get-Content -Raw -LiteralPath $attemptFile)
    if ($attempts -ne 2) {
        throw "Expected the launcher to retry once after the first failed child process; actual attempts: $attempts."
    }

    $status = & curl.exe --noproxy '*' --silent --output NUL --write-out '%{http_code}' --max-time 2 "$serviceUrl/api/bootstrap"
    if ($LASTEXITCODE -ne 0 -or $status.Trim() -ne '200') {
        throw "Expected a healthy service after retry; actual status: $status."
    }

    Write-Host 'PASS launcher retries a failed child start and reaches a healthy service.'
}
finally {
    Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
        Where-Object { $_.CommandLine -like "*$fakeNodePath*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item Env:LAUNCHER_TEST_ATTEMPT_FILE -ErrorAction SilentlyContinue
    Remove-Item Env:LAUNCHER_TEST_SERVICE_URL -ErrorAction SilentlyContinue
}
