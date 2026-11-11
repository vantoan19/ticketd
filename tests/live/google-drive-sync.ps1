[CmdletBinding()]
param(
    # The saved Drive connection (a UUID in this OS user's secure store) to write with.
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string] $ConnectionId
)

# Live check of the Workspace sync Drive adapter: two device handles exchange
# synthetic files through one new, uniquely named Drive folder. Nothing is
# trashed, deleted or shared; the folder is left in Drive for inspection.
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$runId = [guid]::NewGuid().ToString('N').Substring(0, 10)
$output = Join-Path $root "target\live-verification\sync-$runId"
New-Item -ItemType Directory -Force -Path $output | Out-Null
$report = Join-Path $output 'report.txt'

$previous = $env:TICKETD_LIVE_DRIVE_CONNECTION
$env:TICKETD_LIVE_DRIVE_CONNECTION = $ConnectionId
try {
    Push-Location $root
    $ErrorActionPreference = 'Continue'
    & cargo test --locked -p ticketd-core --test drive_remote_live -- --ignored --nocapture --test-threads 1 2>&1 |
        ForEach-Object { [string] $_ } |
        Tee-Object -FilePath $report
    $exitCode = $LASTEXITCODE
}
finally {
    Pop-Location
    $env:TICKETD_LIVE_DRIVE_CONNECTION = $previous
}

$revision = (& git -C $root rev-parse HEAD)
Add-Content -Path $report -Value "source revision: $revision"
Write-Host "Report: $report"
# 0: every step passed. 1: a step failed or the run was blocked; read the report.
exit ([int]($exitCode -ne 0))
