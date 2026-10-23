$ErrorActionPreference = 'Stop'
$taskNode = (Get-Command node.exe -ErrorAction Stop).Source
$taskData = Join-Path $PSScriptRoot 'data'
New-Item -ItemType Directory -Path $taskData -Force | Out-Null
$taskLockPath = Join-Path $taskData 'bridge.lock'
if (Test-Path -LiteralPath $taskLockPath) {
    $taskLockFile = Get-Item -LiteralPath $taskLockPath
    $taskLock = Get-Content -LiteralPath $taskLockPath -Raw | ConvertFrom-Json
    $taskOwner = Get-Process -Id $taskLock.pid -ErrorAction SilentlyContinue
    # A PID may belong to another process after reboot; only accept the original Node process.
    if ($taskOwner -and $taskOwner.ProcessName -eq 'node' -and $taskOwner.StartTime.ToUniversalTime() -le $taskLockFile.LastWriteTimeUtc) {
        Write-Output 'Bridge is already running.'
        return
    }
    Remove-Item -LiteralPath $taskLockPath
}
$taskStopPath = Join-Path $taskData 'stop-request.json'
if (Test-Path -LiteralPath $taskStopPath) { Remove-Item -LiteralPath $taskStopPath }
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
foreach ($taskLog in @('service.log', 'service-error.log')) {
    $taskLogPath = Join-Path $taskData $taskLog
    if (Test-Path -LiteralPath $taskLogPath) { Rename-Item -LiteralPath $taskLogPath -NewName "$taskStamp-$taskLog" }
}
$taskProcess = Start-Process -FilePath $taskNode -ArgumentList @('src/cli.mjs', 'start') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskData 'service.log') -RedirectStandardError (Join-Path $taskData 'service-error.log') -PassThru
Start-Sleep -Seconds 2
if ($taskProcess.HasExited) { throw 'Bridge did not start. Check data/service-error.log.' }
Write-Output "Bridge started in background. PID: $($taskProcess.Id)"
