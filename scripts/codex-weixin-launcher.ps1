param(
    [switch]$NoOpen,
    [string]$NodePath = "",
    [string]$EntryPath = "",
    [string]$WorkingDirectory = "",
    [string]$ServiceUrl = "http://127.0.0.1:8787",
    [string[]]$NodeArguments = @(),
    [ValidateRange(1, 10)]
    [int]$MaxStartupAttempts = 3,
    [ValidateRange(1, 60)]
    [int]$StartupAttemptTimeoutSeconds = 10,
    [ValidateRange(0, 60)]
    [int]$RetryDelaySeconds = 3
)

$ErrorActionPreference = "Stop"
$packageRoot = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $env:LOCALAPPDATA "CodexWeixin\logs"

if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $nvmNodePath = "C:\nvm4w\nodejs\node.exe"
    if (Test-Path -LiteralPath $nvmNodePath) {
        $NodePath = $nvmNodePath
    } else {
        $NodePath = (Get-Command node.exe -ErrorAction Stop).Source
    }
}

if ([string]::IsNullOrWhiteSpace($EntryPath)) {
    $EntryPath = Join-Path $packageRoot "dist\server\index.js"
}

if ([string]::IsNullOrWhiteSpace($WorkingDirectory)) {
    $WorkingDirectory = $packageRoot
}

function Test-CodexWeixinService {
    $status = & curl.exe `
        --noproxy "*" `
        --silent `
        --output NUL `
        --write-out "%{http_code}" `
        --max-time 2 `
        "$ServiceUrl/api/bootstrap"
    return $LASTEXITCODE -eq 0 -and $status.Trim() -eq "200"
}

function Write-LauncherLog {
    param([string]$Message)

    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath (Join-Path $logDirectory "launcher.log") -Value "$timestamp $Message"
}

if (-not (Test-Path -LiteralPath $NodePath)) {
    throw "Node.js is not installed at $NodePath"
}

if (-not (Test-Path -LiteralPath $EntryPath)) {
    throw "The Codex 微信 ClawBot build is unavailable at $EntryPath"
}

if (-not (Test-CodexWeixinService)) {
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $lastFailure = $null

    foreach ($attempt in 1..$MaxStartupAttempts) {
        $stamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
        $stdout = Join-Path $logDirectory "server-$stamp-attempt$attempt.out.log"
        $stderr = Join-Path $logDirectory "server-$stamp-attempt$attempt.err.log"

        $env:CODEX_WEIXIN_OPEN = "0"
        $env:CODEX_WEIXIN_PORT = ([uri]$ServiceUrl).Port
        Write-LauncherLog "Starting service (attempt $attempt/$MaxStartupAttempts)."

        $arguments = @($NodeArguments) + @($EntryPath)
        $process = Start-Process `
            -FilePath $NodePath `
            -ArgumentList $arguments `
            -WorkingDirectory $WorkingDirectory `
            -WindowStyle Hidden `
            -RedirectStandardOutput $stdout `
            -RedirectStandardError $stderr `
            -PassThru
        Write-LauncherLog "Started process $($process.Id): $NodePath $($arguments -join ' ')"

        $deadline = (Get-Date).AddSeconds($StartupAttemptTimeoutSeconds)
        $ready = $false
        while ((Get-Date) -lt $deadline) {
            if (Test-CodexWeixinService) {
                $ready = $true
                break
            }
            $process.Refresh()
            if ($process.HasExited) {
                break
            }
            Start-Sleep -Milliseconds 500
        }

        if ($ready) {
            Write-LauncherLog "Service is healthy after attempt $attempt."
            break
        }

        $exitDescription = if ($process.HasExited) {
            "exited with code $($process.ExitCode)"
        } else {
            "did not become healthy within $StartupAttemptTimeoutSeconds seconds"
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
        $lastFailure = "Attempt $attempt/$MaxStartupAttempts $exitDescription. See $stderr"
        Write-LauncherLog $lastFailure

        if ($attempt -lt $MaxStartupAttempts) {
            Start-Sleep -Seconds $RetryDelaySeconds
        }
    }

    if (-not (Test-CodexWeixinService)) {
        throw "Codex 微信 ClawBot did not become ready after $MaxStartupAttempts attempts. $lastFailure"
    }
}

if (-not $NoOpen) {
    Start-Process $ServiceUrl
}
