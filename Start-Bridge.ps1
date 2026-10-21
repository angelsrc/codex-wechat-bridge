$ErrorActionPreference = 'Stop'
$taskNode = (Get-Command node.exe -ErrorAction Stop).Source
$taskData = Join-Path $PSScriptRoot 'data'
New-Item -ItemType Directory -Path $taskData -Force | Out-Null
$taskLockPath = Join-Path $taskData 'bridge.lock'
if (Test-Path -LiteralPath $taskLockPath) {
    $taskLock = Get-Content -LiteralPath $taskLockPath -Raw | ConvertFrom-Json
    if (Get-Process -Id $taskLock.pid -ErrorAction SilentlyContinue) { throw 'Bridge is already running.' }
}
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
foreach ($taskLog in @('service.log', 'service-error.log')) {
    $taskLogPath = Join-Path $taskData $taskLog
    if (Test-Path -LiteralPath $taskLogPath) { Rename-Item -LiteralPath $taskLogPath -NewName "$taskStamp-$taskLog" }
}
$taskProcess = Start-Process -FilePath $taskNode -ArgumentList @('src/cli.mjs', 'start') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskData 'service.log') -RedirectStandardError (Join-Path $taskData 'service-error.log') -PassThru
Start-Sleep -Seconds 2
if ($taskProcess.HasExited) { throw 'Bridge did not start. Check data/service-error.log.' }
Write-Output "Bridge started in background. PID: $($taskProcess.Id)"
