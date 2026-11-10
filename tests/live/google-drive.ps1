[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $CliPath,

    [Parameter(Mandatory = $true)]
    [string] $ConnectionId,

    [Parameter(Mandatory = $true)]
    [string] $FolderId,

    [string] $ResourceKey,

    [ValidateRange(1, 3)]
    [int] $Rounds = 1,

    [switch] $RequireUploadedCopyClassification
)

$ErrorActionPreference = 'Stop'
$script:CliPath = [System.IO.Path]::GetFullPath($CliPath)
$script:Cases = New-Object 'System.Collections.Generic.List[object]'
$script:RemoteFiles = New-Object 'System.Collections.Generic.List[object]'
$script:AbortMutations = $false
$script:AbortRemoteChecks = $false
$script:RunId = [guid]::NewGuid().ToString('N')
$script:RunToken = $script:RunId.Substring(0, 10)
$script:OutputPath = $null

function Get-SafeErrorCode {
    param([string] $Text)

    if ($Text -match '(?i)request ID was already used for different content') {
        return 'request_conflict'
    }
    if ($Text -match '(?i)file already exists at .*?ticketd never replaces an existing file') {
        return 'destination_already_exists'
    }
    if ($Text -match '(?i)unconfigured|unauthori[sz]ed|reauthori[sz]e|credential|secure store|token|access denied|\b401\b|\b403\b') {
        return 'blocked_authorization'
    }
    if ($Text -match '(?i)timeout|timed out|network|connection reset|connection refused|name resolution|dns|temporar|\b429\b|\b5\d\d\b|tls|ssl|offline') {
        return 'blocked_network_or_provider'
    }
    if ($Text -match '(?i)folder|writable|permission|parent') {
        return 'blocked_folder_access'
    }
    return 'cli_error'
}

function Invoke-Ticketd {
    param([Parameter(Mandatory = $true)][string[]] $Arguments)

    $lines = @(& $script:CliPath @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
    $raw = ($lines | ForEach-Object {
        if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() }
        else { [string] $_ }
    }) -join "`n"
    $parsed = $null
    $errorCode = $null
    if ($exitCode -eq 0) {
        try {
            $parsed = ConvertFrom-Json -InputObject $raw -ErrorAction Stop
        }
        catch {
            $errorCode = 'invalid_cli_json'
        }
    }
    else {
        $errorCode = Get-SafeErrorCode -Text $raw
    }

    return [pscustomobject]@{
        ExitCode = $exitCode
        Parsed = $parsed
        ErrorCode = $errorCode
        Raw = $raw
    }
}

function Add-Case {
    param(
        [Parameter(Mandatory = $true)][string] $CaseId,
        [Parameter(Mandatory = $true)][ValidateSet('passed', 'failed', 'blocked', 'skipped')][string] $Status,
        [Parameter(Mandatory = $true)][string] $Assertion,
        [string] $RequestId,
        [Nullable[long]] $SizeBytes,
        [Nullable[long]] $AlternateSizeBytes,
        [string] $AlternateFileName,
        [string] $Sha256,
        [string] $AttachmentId,
        [string] $RemoteFileId,
        [string] $OutputPath,
        [string] $ErrorCode
    )

    $script:Cases.Add([pscustomobject][ordered]@{
        caseId = $CaseId
        status = $Status
        assertion = $Assertion
        requestId = $RequestId
        sizeBytes = $SizeBytes
        alternateSizeBytes = $AlternateSizeBytes
        alternateFileName = $AlternateFileName
        sha256 = $Sha256
        attachmentId = $AttachmentId
        remoteFileId = $RemoteFileId
        outputPath = $OutputPath
        errorCode = $ErrorCode
    })
}

function New-SyntheticBytes {
    param([Parameter(Mandatory = $true)][ValidateRange(0, 524411)][int] $Size)

    $bytes = New-Object byte[] $Size
    for ($index = 0; $index -lt $Size; $index++) {
        $bytes[$index] = [byte](($index * 31 + 17) % 251)
    }
    return ,$bytes
}

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]] $Bytes)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

function Get-FileSha256 {
    param([Parameter(Mandatory = $true)][string] $Path)

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    return Get-Sha256 -Bytes $bytes
}

function Test-DriveDestination {
    param([Parameter(Mandatory = $true)] $Destination)

    if ($null -eq $Destination -or $Destination.kind -ne 'google_drive' -or $null -eq $Destination.destination) {
        return $false
    }
    $actualConnection = [string]$Destination.destination.connection_id
    $actualFolder = [string]$Destination.destination.folder_id
    $actualResourceKey = if ($null -eq $Destination.destination.resource_key) { '' } else { [string]$Destination.destination.resource_key }
    $expectedResourceKey = if ([string]::IsNullOrWhiteSpace($ResourceKey)) { '' } else { $ResourceKey }
    return [string]::Equals($actualConnection, $ConnectionId, [System.StringComparison]::Ordinal) -and
        [string]::Equals($actualFolder, $FolderId, [System.StringComparison]::Ordinal) -and
        [string]::Equals($actualResourceKey, $expectedResourceKey, [System.StringComparison]::Ordinal)
}

function Test-UploadedCopyTrue {
    param($Attachment)

    if ($null -eq $Attachment) { return $false }
    $property = $Attachment.PSObject.Properties['uploaded_copy']
    return $null -ne $property -and [bool]$property.Value
}

function Get-NormalizedFullPath {
    param([Parameter(Mandatory = $true)][string] $Path)

    $full = [System.IO.Path]::GetFullPath($Path)
    if ($full.StartsWith('\\?\UNC\', [System.StringComparison]::OrdinalIgnoreCase)) {
        return '\\' + $full.Substring(8)
    }
    if ($full.StartsWith('\\?\', [System.StringComparison]::OrdinalIgnoreCase)) {
        return $full.Substring(4)
    }
    return $full
}

function Get-RequestStatusResult {
    param([Parameter(Mandatory = $true)][string] $RequestId)

    return Invoke-Ticketd -Arguments @('attachment', 'drive-upload-status', $RequestId)
}

function Get-RequestStatus {
    param([Parameter(Mandatory = $true)][string] $RequestId)

    $result = Get-RequestStatusResult -RequestId $RequestId
    if ($result.ExitCode -ne 0 -or $null -eq $result.Parsed) {
        return $null
    }
    return $result.Parsed
}

function Reconcile-Request {
    param([Parameter(Mandatory = $true)][string] $RequestId)

    $before = Get-RequestStatus -RequestId $RequestId
    if ($null -eq $before) {
        return $null
    }
    if ($before.state -eq 'completed') {
        return $before
    }
    $check = Invoke-Ticketd -Arguments @('attachment', 'drive-upload-status', $RequestId, '--check')
    if ($check.ExitCode -ne 0 -or $null -eq $check.Parsed) {
        return [pscustomobject]@{
            state = 'check_failed'
            attachment_id = $before.attachment_id
            remote_file_id = $before.remote_file_id
            error_code = $check.ErrorCode
        }
    }
    return $check.Parsed
}

function New-UploadArgumentList {
    param(
        [Parameter(Mandatory = $true)][string] $InputPath,
        [Parameter(Mandatory = $true)][string] $RequestId,
        [string] $UseFolder = $FolderId,
        [string] $Ticket
    )

    $arguments = @(
        'attachment', 'drive-upload', $InputPath,
        '--connection', $ConnectionId,
        '--folder', $UseFolder,
        '--request-id', $RequestId
    )
    if (-not [string]::IsNullOrWhiteSpace($ResourceKey)) {
        $arguments += @('--resource-key', $ResourceKey)
    }
    if (-not [string]::IsNullOrWhiteSpace($Ticket)) {
        $arguments += @('--ticket', $Ticket)
    }
    return ,$arguments
}

function Save-SyntheticInput {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][int] $Size
    )

    $parent = [System.IO.Path]::GetDirectoryName($Path)
    [System.IO.Directory]::CreateDirectory($parent) | Out-Null
    $bytes = New-SyntheticBytes -Size $Size
    [System.IO.File]::WriteAllBytes($Path, $bytes)
    return [pscustomobject]@{ sizeBytes = $Size; sha256 = (Get-Sha256 -Bytes $bytes) }
}

function Add-BlockedCasesForRound {
    param([Parameter(Mandatory = $true)][int] $Round)

    $prefix = 'round-{0:D2}' -f $Round
    foreach ($case in @('upload-boundary-0', 'upload-boundary-1', 'upload-boundary-262143', 'upload-boundary-262144', 'upload-boundary-262145', 'upload-boundary-524411', 'upload-unicode-left', 'upload-unicode-right', 'drive-uploaded-copy-classification', 'retry-same-request', 'path-replay-same-filename-changed-content', 'status-check-reconcile', 'request-input-conflict', 'request-destination-conflict', 'request-local-conflict', 'explicit-local-preference', 'explicit-local-classification', 'search-same-basename', 'normal-export-hashes', 'single-file-export-sha256-size', 'export-no-clobber', 'remove-from-ticketd')) {
        Add-Case -CaseId "$prefix.$case" -Status 'skipped' -Assertion 'Skipped because a prerequisite failed before this case.'
    }
}

function Invoke-Round {
    param(
        [Parameter(Mandatory = $true)][int] $Round,
        [Parameter(Mandatory = $true)][string] $RoundRoot
    )

    $prefix = 'round-{0:D2}' -f $Round
    $inputRoot = Join-Path $RoundRoot 'inputs'
    $exportRoot = Join-Path $RoundRoot 'exports'
    [System.IO.Directory]::CreateDirectory($inputRoot) | Out-Null
    [System.IO.Directory]::CreateDirectory($exportRoot) | Out-Null

    $workspaceFile = Join-Path (Join-Path $RoundRoot 'workspace') 'workspace.sqlite3'
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($workspaceFile)) | Out-Null
    [Environment]::SetEnvironmentVariable('TICKETD_TEST_WORKSPACE', $workspaceFile, 'Process')
    [Environment]::SetEnvironmentVariable('TICKETD_GOOGLE_OAUTH_CLIENT_FILE', $null, 'Process')
    [Environment]::SetEnvironmentVariable('TICKETD_GOOGLE_OAUTH_CLIENT_JSON', $null, 'Process')

    $workspaceProbe = Invoke-Ticketd -Arguments @('workspace')
    $workspaceMatches = $false
    if ($workspaceProbe.ExitCode -eq 0 -and $null -ne $workspaceProbe.Parsed -and -not [string]::IsNullOrWhiteSpace($workspaceProbe.Parsed.path)) {
        $reportedWorkspace = Get-NormalizedFullPath -Path ([string]$workspaceProbe.Parsed.path)
        $expectedWorkspace = Get-NormalizedFullPath -Path $workspaceFile
        $workspaceMatches = [string]::Equals($reportedWorkspace, $expectedWorkspace, [System.StringComparison]::OrdinalIgnoreCase)
    }
    if (-not $workspaceMatches) {
        Add-Case -CaseId "$prefix.workspace-isolation" -Status 'failed' -Assertion 'The selected CLI did not resolve workspace to the round-specific isolated database; no write command was run.' -OutputPath 'workspace/workspace.sqlite3' -ErrorCode $(if ($workspaceProbe.ExitCode -ne 0) { $workspaceProbe.ErrorCode } else { 'workspace_path_mismatch' })
        Add-BlockedCasesForRound -Round $Round
        return
    }
    Add-Case -CaseId "$prefix.workspace-isolation" -Status 'passed' -Assertion 'The CLI resolved TICKETD_TEST_WORKSPACE to the round-specific isolated database before any mutation.' -OutputPath 'workspace/workspace.sqlite3'

    $ticketResult = Invoke-Ticketd -Arguments @('create', "ticketd Google Drive live verification $script:RunToken round $Round")
    if ($ticketResult.ExitCode -ne 0 -or $null -eq $ticketResult.Parsed -or [string]::IsNullOrWhiteSpace($ticketResult.Parsed.reference)) {
        Add-Case -CaseId "$prefix.workspace-create" -Status 'failed' -Assertion 'Could not create the synthetic ticket in the isolated workspace.' -ErrorCode $ticketResult.ErrorCode
        Add-BlockedCasesForRound -Round $Round
        return
    }
    $ticket = [string]$ticketResult.Parsed.reference
    Add-Case -CaseId "$prefix.workspace-create" -Status 'passed' -Assertion 'Synthetic ticket created in the round-specific isolated workspace.'

    $destinationArgs = @('attachment', 'destination', '--drive', '--connection', $ConnectionId, '--folder', $FolderId)
    if (-not [string]::IsNullOrWhiteSpace($ResourceKey)) {
        $destinationArgs += @('--resource-key', $ResourceKey)
    }
    $destinationResult = Invoke-Ticketd -Arguments $destinationArgs
    if ($destinationResult.ExitCode -ne 0 -or -not (Test-DriveDestination -Destination $destinationResult.Parsed)) {
        $errorCode = $destinationResult.ErrorCode
        $status = if ($errorCode -like 'blocked_*') { 'blocked' } else { 'failed' }
        Add-Case -CaseId "$prefix.destination-validation" -Status $status -Assertion 'Explicit Drive destination validation did not confirm the supplied account and folder.' -ErrorCode $errorCode
        Add-BlockedCasesForRound -Round $Round
        return
    }
    Add-Case -CaseId "$prefix.destination-validation" -Status 'passed' -Assertion 'The explicitly supplied writable Drive destination was validated and saved in the isolated workspace.'

    $specs = New-Object 'System.Collections.Generic.List[object]'
    foreach ($size in @(0, 1, 262143, 262144, 262145, 524411)) {
        $filename = 'ticketd-live-{0}-r{1:D2}-boundary-{2}.bin' -f $script:RunToken, $Round, $size
        $path = Join-Path $inputRoot $filename
        $data = Save-SyntheticInput -Path $path -Size $size
        $specs.Add([pscustomobject]@{ caseId = "upload-boundary-$size"; fileName = $filename; path = $path; sizeBytes = $data.sizeBytes; sha256 = $data.sha256 })
    }
    foreach ($side in @('left', 'right')) {
        $filename = 'ticketd-live-{0}-r{1:D2}-東京 same name.bin' -f $script:RunToken, $Round
        $path = Join-Path (Join-Path $inputRoot $side) $filename
        $size = if ($side -eq 'left') { 37 } else { 53 }
        $data = Save-SyntheticInput -Path $path -Size $size
        $specs.Add([pscustomobject]@{ caseId = "upload-unicode-$side"; fileName = $filename; path = $path; sizeBytes = $data.sizeBytes; sha256 = $data.sha256 })
    }

    $uploaded = New-Object 'System.Collections.Generic.List[object]'
    $uploadCases = @{}
    foreach ($spec in $specs) {
        if ($script:AbortMutations) { break }
        $requestId = 'gdlive-{0}-r{1:D2}-{2}' -f $script:RunToken, $Round, ($spec.caseId -replace '[^A-Za-z0-9-]', '-')
        $arguments = New-UploadArgumentList -InputPath $spec.path -RequestId $requestId -Ticket $ticket
        $upload = Invoke-Ticketd -Arguments $arguments
        $attachmentId = $null
        $remoteFileId = $null
        $state = $null
        $classificationPresent = $false
        $uploadedCopyValue = $null

        if ($upload.ExitCode -eq 0 -and $null -ne $upload.Parsed -and -not [string]::IsNullOrWhiteSpace($upload.Parsed.id)) {
            $attachmentId = [string]$upload.Parsed.id
            $uploadedCopyProperty = $upload.Parsed.PSObject.Properties['uploaded_copy']
            if ($null -ne $uploadedCopyProperty) {
                $classificationPresent = $true
                $uploadedCopyValue = [bool]$uploadedCopyProperty.Value
            }
        }

        $operationStatus = Get-RequestStatusResult -RequestId $requestId
        $operation = if ($operationStatus.ExitCode -eq 0) { $operationStatus.Parsed } else { $null }
        if ($null -ne $operation -and $operation.state -ne 'completed') {
            $operation = Reconcile-Request -RequestId $requestId
        }

        if ($null -ne $operation) {
            if ($operation.state -eq 'completed') {
                $remoteFileId = [string]$operation.remote_file_id
                if ([string]::IsNullOrWhiteSpace($attachmentId)) {
                    $attachmentId = [string]$operation.attachment_id
                    $recover = Invoke-Ticketd -Arguments @('attachment', 'drive-upload', $spec.path, '--connection', $ConnectionId, '--folder', $FolderId, '--request-id', $requestId, '--ticket', $ticket)
                    if ($recover.ExitCode -eq 0 -and $null -ne $recover.Parsed -and $recover.Parsed.id -eq $attachmentId) {
                        $upload = $recover
                        $uploadedCopyProperty = $upload.Parsed.PSObject.Properties['uploaded_copy']
                        if ($null -ne $uploadedCopyProperty) {
                            $classificationPresent = $true
                            $uploadedCopyValue = [bool]$uploadedCopyProperty.Value
                        }
                    }
                }
            }
            elseif ($operation.state -eq 'check_failed' -or $operation.state -eq 'uncertain' -or $operation.state -eq 'pending') {
                $script:AbortMutations = $true
                $script:AbortRemoteChecks = $true
            }
        }

        $uploadPassed = $upload.ExitCode -eq 0 -and $null -ne $operation -and $operation.state -eq 'completed' -and
            $attachmentId -eq [string]$operation.attachment_id -and -not [string]::IsNullOrWhiteSpace($remoteFileId)
        if ($uploadPassed) {
            $uploadedItem = [pscustomobject]@{
                caseId = "$prefix.$($spec.caseId)"
                requestId = $requestId
                inputPath = $spec.path
                fileName = $spec.fileName
                sizeBytes = [long]$spec.sizeBytes
                sha256 = $spec.sha256
                attachmentId = $attachmentId
                remoteFileId = $remoteFileId
                uploadedCopyFieldPresent = $classificationPresent
                uploadedCopy = $uploadedCopyValue
            }
            $uploaded.Add($uploadedItem)
            $script:RemoteFiles.Add([pscustomobject]@{
                caseId = $uploadedItem.caseId
                requestId = $requestId
                attachmentId = $attachmentId
                remoteFileId = $remoteFileId
                sizeBytes = [long]$spec.sizeBytes
                sha256 = $spec.sha256
            })
            $uploadCases[$spec.caseId] = $uploadedItem
            Add-Case -CaseId $uploadedItem.caseId -Status 'passed' -Assertion 'New synthetic input uploaded and one completed remote identity was recorded.' -RequestId $requestId -SizeBytes $spec.sizeBytes -Sha256 $spec.sha256 -AttachmentId $attachmentId -RemoteFileId $remoteFileId
        }
        else {
            $status = 'failed'
            $errorCode = if ($upload.ExitCode -ne 0) { $upload.ErrorCode } elseif ($operationStatus.ExitCode -ne 0) { $operationStatus.ErrorCode } else { $null }
            if ($null -eq $operation -and ($errorCode -like 'blocked_*' -or $operationStatus.ErrorCode -like 'blocked_*')) { $status = 'blocked' }
            if ($null -ne $operation -and $operation.state -in @('pending', 'uncertain', 'check_failed')) {
                $status = 'blocked'
                $errorCode = if ($operation.error_code) { [string]$operation.error_code } else { 'upload_uncertain_reconcile_required' }
            }
            Add-Case -CaseId "$prefix.$($spec.caseId)" -Status $status -Assertion 'Upload did not reach a confirmed completed state; no new request was issued to replace it.' -RequestId $requestId -SizeBytes $spec.sizeBytes -Sha256 $spec.sha256 -AttachmentId $attachmentId -RemoteFileId $remoteFileId -OutputPath 'workspace/drive-upload-status' -ErrorCode $errorCode
            if ($status -eq 'blocked' -or $null -ne $operation) {
                $script:AbortMutations = $true
                $script:AbortRemoteChecks = $true
            }
        }
    }

    if ($uploaded.Count -gt 0) {
        $classificationMissing = @($uploaded | Where-Object { -not $_.uploadedCopyFieldPresent }).Count
        $classificationIncorrect = @($uploaded | Where-Object { $_.uploadedCopyFieldPresent -and -not $_.uploadedCopy }).Count
        if ($classificationIncorrect -gt 0) {
            Add-Case -CaseId "$prefix.drive-uploaded-copy-classification" -Status 'failed' -Assertion 'A confirmed Drive upload did not report uploaded_copy=true.' -ErrorCode 'uploaded_copy_false'
        }
        elseif ($classificationMissing -gt 0 -and $RequireUploadedCopyClassification) {
            Add-Case -CaseId "$prefix.drive-uploaded-copy-classification" -Status 'failed' -Assertion 'The required uploaded_copy classification field was absent from the built CLI.' -ErrorCode 'required_field_missing'
        }
        elseif ($classificationMissing -gt 0) {
            Add-Case -CaseId "$prefix.drive-uploaded-copy-classification" -Status 'blocked' -Assertion 'The upload completed, but this older CLI artifact does not expose uploaded_copy classification.' -ErrorCode 'expected_old_build_missing_uploaded_copy_field'
        }
        else {
            Add-Case -CaseId "$prefix.drive-uploaded-copy-classification" -Status 'passed' -Assertion 'Every confirmed Drive upload reported uploaded_copy=true.'
        }
    }
    else {
        Add-Case -CaseId "$prefix.drive-uploaded-copy-classification" -Status 'skipped' -Assertion 'Skipped because no upload reached a confirmed completed state.'
    }

    if ($uploaded.Count -gt 0 -and -not $script:AbortRemoteChecks) {
        # Separate CLI process replay must return the first identity; this uses a zero-byte operation when available.
        $replayItem = $uploaded | Where-Object { $_.caseId -like '*.upload-boundary-0' } | Select-Object -First 1
        if ($null -eq $replayItem) { $replayItem = $uploaded[0] }
        $replay = Invoke-Ticketd -Arguments (New-UploadArgumentList -InputPath $replayItem.inputPath -RequestId $replayItem.requestId -Ticket $ticket)
        $replayStatusResult = Get-RequestStatusResult -RequestId $replayItem.requestId
        $replayStatus = if ($replayStatusResult.ExitCode -eq 0) { $replayStatusResult.Parsed } else { $null }
        $replayPassed = $replay.ExitCode -eq 0 -and $null -ne $replay.Parsed -and $replay.Parsed.id -eq $replayItem.attachmentId -and
            (Test-UploadedCopyTrue -Attachment $replay.Parsed) -and
            $null -ne $replayStatus -and $replayStatus.remote_file_id -eq $replayItem.remoteFileId
        $replayError = if ($replayPassed) { $null } elseif ($replay.ErrorCode -like 'blocked_*') { $replay.ErrorCode } elseif ($replayStatusResult.ErrorCode -like 'blocked_*') { $replayStatusResult.ErrorCode } elseif ($replay.ExitCode -ne 0) { $replay.ErrorCode } else { 'identity_or_uploaded_copy_mismatch' }
        $replayCaseStatus = if ($replayError -like 'blocked_*') { 'blocked' } else { 'failed' }
        Add-Case -CaseId "$prefix.retry-same-request" -Status $(if ($replayPassed) { 'passed' } else { $replayCaseStatus }) -Assertion 'A new CLI process replayed the same request, preserved attachment and remote file identity, and projected uploaded_copy=true.' -RequestId $replayItem.requestId -SizeBytes $replayItem.sizeBytes -Sha256 $replayItem.sha256 -AttachmentId $replayItem.attachmentId -RemoteFileId $replayItem.remoteFileId -ErrorCode $replayError

        $changedPath = Join-Path (Join-Path $inputRoot 'changed-path') $replayItem.fileName
        $changedPathData = Save-SyntheticInput -Path $changedPath -Size ([int]$replayItem.sizeBytes + 1)
        $pathReplay = Invoke-Ticketd -Arguments @('attachment', 'add', $changedPath, '--request-id', $replayItem.requestId)
        $pathReplayStatusResult = Get-RequestStatusResult -RequestId $replayItem.requestId
        $pathReplayStatus = if ($pathReplayStatusResult.ExitCode -eq 0) { $pathReplayStatusResult.Parsed } else { $null }
        $pathReplayPassed = $pathReplay.ExitCode -eq 0 -and $null -ne $pathReplay.Parsed -and $pathReplay.Parsed.id -eq $replayItem.attachmentId -and
            (Test-UploadedCopyTrue -Attachment $pathReplay.Parsed) -and
            $null -ne $pathReplayStatus -and $pathReplayStatus.remote_file_id -eq $replayItem.remoteFileId
        $pathReplayError = if ($pathReplayPassed) { $null } elseif ($pathReplay.ErrorCode -like 'blocked_*') { $pathReplay.ErrorCode } elseif ($pathReplayStatusResult.ErrorCode -like 'blocked_*') { $pathReplayStatusResult.ErrorCode } elseif ($pathReplay.ExitCode -ne 0) { $pathReplay.ErrorCode } else { 'identity_or_uploaded_copy_mismatch' }
        $pathReplayCaseStatus = if ($pathReplayError -like 'blocked_*') { 'blocked' } else { 'failed' }
        Add-Case -CaseId "$prefix.path-replay-same-filename-changed-content" -Status $(if ($pathReplayPassed) { 'passed' } else { $pathReplayCaseStatus }) -Assertion 'Path-based attachment add with the same filename replayed the completed identity, preserved the original remote copy, and projected uploaded_copy=true.' -RequestId $replayItem.requestId -SizeBytes $replayItem.sizeBytes -AlternateSizeBytes $changedPathData.sizeBytes -AlternateFileName $replayItem.fileName -Sha256 $replayItem.sha256 -AttachmentId $replayItem.attachmentId -RemoteFileId $replayItem.remoteFileId -ErrorCode $pathReplayError

        $checkItem = $uploaded | Where-Object { $_.caseId -like '*.upload-boundary-524411' } | Select-Object -First 1
        if ($null -eq $checkItem) { $checkItem = $uploaded[$uploaded.Count - 1] }
        $beforeCheck = Get-RequestStatus -RequestId $checkItem.requestId
        $checked = Invoke-Ticketd -Arguments @('attachment', 'drive-upload-status', $checkItem.requestId, '--check')
        $checkPassed = $checked.ExitCode -eq 0 -and $null -ne $checked.Parsed -and $checked.Parsed.state -eq 'completed' -and
            $checked.Parsed.remote_file_id -eq $checkItem.remoteFileId -and $checked.Parsed.attachment_id -eq $checkItem.attachmentId
        Add-Case -CaseId "$prefix.status-check-reconcile" -Status $(if ($checkPassed) { 'passed' } else { 'failed' }) -Assertion 'Status check retained the completed identity and reconciled without creating another remote ID.' -RequestId $checkItem.requestId -SizeBytes $checkItem.sizeBytes -Sha256 $checkItem.sha256 -AttachmentId $checkItem.attachmentId -RemoteFileId $checkItem.remoteFileId -ErrorCode $(if ($checkPassed) { $null } elseif ($checked.ExitCode -ne 0) { $checked.ErrorCode } else { 'identity_mismatch' })
    }
    else {
        foreach ($case in @('retry-same-request', 'path-replay-same-filename-changed-content', 'status-check-reconcile')) {
            Add-Case -CaseId "$prefix.$case" -Status 'skipped' -Assertion 'Skipped because no upload reached a confirmed completed state.'
        }
    }

    if ($uploaded.Count -gt 0) {
        $conflictItem = $uploaded[0]
        $conflictName = 'ticketd-live-{0}-r{1:D2}-different-name.bin' -f $script:RunToken, $Round
        $conflictPath = Join-Path (Join-Path $inputRoot 'conflict') $conflictName
        $conflictData = Save-SyntheticInput -Path $conflictPath -Size ([int]$conflictItem.sizeBytes + 1)
        $conflictArgs = New-UploadArgumentList -InputPath $conflictPath -RequestId $conflictItem.requestId
        $inputConflict = Invoke-Ticketd -Arguments $conflictArgs
        $inputConflictStatus = Get-RequestStatusResult -RequestId $conflictItem.requestId
        $afterInputConflict = $inputConflictStatus.Parsed
        $inputConflictPassed = $inputConflict.ExitCode -ne 0 -and $inputConflict.ErrorCode -eq 'request_conflict' -and
            $inputConflictStatus.ExitCode -eq 0 -and $null -ne $afterInputConflict -and
            $afterInputConflict.attachment_id -eq $conflictItem.attachmentId -and $afterInputConflict.remote_file_id -eq $conflictItem.remoteFileId
        $inputConflictError = if ($inputConflictPassed) { $null } elseif ($inputConflict.ErrorCode -like 'blocked_*') { $inputConflict.ErrorCode } elseif ($inputConflictStatus.ErrorCode -like 'blocked_*') { $inputConflictStatus.ErrorCode } elseif ($inputConflict.ErrorCode -ne 'request_conflict') { 'expected_request_conflict_error' } else { 'original_request_identity_mismatch' }
        $inputConflictCaseStatus = if ($inputConflictError -like 'blocked_*') { 'blocked' } else { 'failed' }
        Add-Case -CaseId "$prefix.request-input-conflict" -Status $(if ($inputConflictPassed) { 'passed' } else { $inputConflictCaseStatus }) -Assertion 'Same request ID with a different synthetic filename and bytes returned the specific request-conflict error and left the original identity unchanged.' -RequestId $conflictItem.requestId -SizeBytes $conflictItem.sizeBytes -AlternateSizeBytes $conflictData.sizeBytes -AlternateFileName $conflictName -Sha256 $conflictItem.sha256 -AttachmentId $conflictItem.attachmentId -RemoteFileId $conflictItem.remoteFileId -OutputPath 'workspace/drive-upload-status' -ErrorCode $inputConflictError
        if (-not $inputConflictPassed) { $script:AbortMutations = $true }

        $otherFolder = if ($FolderId[0] -eq 'A') { 'B' + $FolderId.Substring(1) } else { 'A' + $FolderId.Substring(1) }
        $destinationConflictArgs = New-UploadArgumentList -InputPath $conflictItem.inputPath -RequestId $conflictItem.requestId -UseFolder $otherFolder
        $destinationConflict = Invoke-Ticketd -Arguments $destinationConflictArgs
        $destinationConflictStatus = Get-RequestStatusResult -RequestId $conflictItem.requestId
        $afterDestinationConflict = $destinationConflictStatus.Parsed
        $destinationConflictPassed = $destinationConflict.ExitCode -ne 0 -and $destinationConflict.ErrorCode -eq 'request_conflict' -and
            $destinationConflictStatus.ExitCode -eq 0 -and $null -ne $afterDestinationConflict -and
            $afterDestinationConflict.attachment_id -eq $conflictItem.attachmentId -and $afterDestinationConflict.remote_file_id -eq $conflictItem.remoteFileId
        $destinationConflictError = if ($destinationConflictPassed) { $null } elseif ($destinationConflict.ErrorCode -like 'blocked_*') { $destinationConflict.ErrorCode } elseif ($destinationConflictStatus.ErrorCode -like 'blocked_*') { $destinationConflictStatus.ErrorCode } elseif ($destinationConflict.ErrorCode -ne 'request_conflict') { 'expected_request_conflict_error' } else { 'original_request_identity_mismatch' }
        $destinationConflictCaseStatus = if ($destinationConflictError -like 'blocked_*') { 'blocked' } else { 'failed' }
        Add-Case -CaseId "$prefix.request-destination-conflict" -Status $(if ($destinationConflictPassed) { 'passed' } else { $destinationConflictCaseStatus }) -Assertion 'Same request ID with a different folder returned the specific request-conflict error before any second remote write.' -RequestId $conflictItem.requestId -SizeBytes $conflictItem.sizeBytes -Sha256 $conflictItem.sha256 -AttachmentId $conflictItem.attachmentId -RemoteFileId $conflictItem.remoteFileId -OutputPath 'workspace/drive-upload-status' -ErrorCode $destinationConflictError
        if (-not $destinationConflictPassed) { $script:AbortMutations = $true }

        $localConflict = Invoke-Ticketd -Arguments @('attachment', 'add', $conflictItem.inputPath, '--local', '--request-id', $conflictItem.requestId)
        $localConflictStatus = Get-RequestStatusResult -RequestId $conflictItem.requestId
        $afterLocalConflict = $localConflictStatus.Parsed
        $localConflictPassed = $localConflict.ExitCode -ne 0 -and $localConflict.ErrorCode -eq 'request_conflict' -and
            $localConflictStatus.ExitCode -eq 0 -and $null -ne $afterLocalConflict -and
            $afterLocalConflict.attachment_id -eq $conflictItem.attachmentId -and $afterLocalConflict.remote_file_id -eq $conflictItem.remoteFileId
        $localConflictError = if ($localConflictPassed) { $null } elseif ($localConflict.ErrorCode -like 'blocked_*') { $localConflict.ErrorCode } elseif ($localConflictStatus.ErrorCode -like 'blocked_*') { $localConflictStatus.ErrorCode } elseif ($localConflict.ErrorCode -ne 'request_conflict') { 'expected_request_conflict_error' } else { 'original_request_identity_mismatch' }
        $localConflictCaseStatus = if ($localConflictError -like 'blocked_*') { 'blocked' } else { 'failed' }
        Add-Case -CaseId "$prefix.request-local-conflict" -Status $(if ($localConflictPassed) { 'passed' } else { $localConflictCaseStatus }) -Assertion 'Explicit local override returned the specific request-conflict error for an existing Drive request and did not replace its identity.' -RequestId $conflictItem.requestId -SizeBytes $conflictItem.sizeBytes -Sha256 $conflictItem.sha256 -AttachmentId $conflictItem.attachmentId -RemoteFileId $conflictItem.remoteFileId -OutputPath 'workspace/drive-upload-status' -ErrorCode $localConflictError
        if (-not $localConflictPassed) { $script:AbortMutations = $true }
    }
    else {
        foreach ($case in @('request-input-conflict', 'request-destination-conflict', 'request-local-conflict')) {
            Add-Case -CaseId "$prefix.$case" -Status 'skipped' -Assertion 'Skipped because no upload reached a confirmed completed state.'
        }
    }

    $localCaseStatus = 'skipped'
    $localCaseError = $null
    $localAttachmentId = $null
    if (-not $script:AbortMutations) {
        $localPath = Join-Path $inputRoot ('ticketd-live-{0}-r{1:D2}-explicit-local.bin' -f $script:RunToken, $Round)
        $localData = Save-SyntheticInput -Path $localPath -Size 29
        $localRequest = 'gdlive-{0}-r{1:D2}-explicit-local' -f $script:RunToken, $Round
        $localAdd = Invoke-Ticketd -Arguments @('attachment', 'add', $localPath, '--local', '--request-id', $localRequest)
        $preferenceAfterLocal = Invoke-Ticketd -Arguments @('attachment', 'destination')
        $localAttachmentId = if ($null -ne $localAdd.Parsed) { [string]$localAdd.Parsed.id } else { $null }
        $localPassed = $localAdd.ExitCode -eq 0 -and $null -ne $localAdd.Parsed -and $localAdd.Parsed.kind -eq 'local_snapshot' -and
            $null -ne $preferenceAfterLocal.Parsed -and (Test-DriveDestination -Destination $preferenceAfterLocal.Parsed)
        $localCaseStatus = if ($localPassed) { 'passed' } else { 'failed' }
        if (-not $localPassed) { $localCaseError = if ($localAdd.ExitCode -ne 0) { $localAdd.ErrorCode } else { 'local_or_destination_assertion_failed' } }
        Add-Case -CaseId "$prefix.explicit-local-preference" -Status $localCaseStatus -Assertion 'Explicit --local created a local snapshot while the validated Drive preference remained unchanged.' -RequestId $localRequest -SizeBytes 29 -Sha256 $localData.sha256 -AttachmentId $localAttachmentId -OutputPath 'workspace/attachment-destination' -ErrorCode $localCaseError
        $localClassification = $null
        if ($null -ne $localAdd.Parsed) { $localClassification = $localAdd.Parsed.PSObject.Properties['uploaded_copy'] }
        if ($null -eq $localClassification -and $RequireUploadedCopyClassification) {
            Add-Case -CaseId "$prefix.explicit-local-classification" -Status 'failed' -Assertion 'The required uploaded_copy field was absent for an explicit local capture.' -ErrorCode 'required_field_missing'
        }
        elseif ($null -eq $localClassification) {
            Add-Case -CaseId "$prefix.explicit-local-classification" -Status 'blocked' -Assertion 'This older CLI artifact does not expose uploaded_copy classification for local captures.' -ErrorCode 'expected_old_build_missing_uploaded_copy_field'
        }
        elseif ([bool]$localClassification.Value -eq $false) {
            Add-Case -CaseId "$prefix.explicit-local-classification" -Status 'passed' -Assertion 'The explicit local capture reported uploaded_copy=false.'
        }
        else {
            Add-Case -CaseId "$prefix.explicit-local-classification" -Status 'failed' -Assertion 'An explicit local capture incorrectly reported uploaded_copy=true.' -ErrorCode 'uploaded_copy_true_for_local'
        }
    }
    else {
        Add-Case -CaseId "$prefix.explicit-local-preference" -Status 'skipped' -Assertion 'Skipped after an unexpected request-conflict result.'
        Add-Case -CaseId "$prefix.explicit-local-classification" -Status 'skipped' -Assertion 'Skipped because explicit local capture did not run.'
    }

    $unicodeItems = @($uploaded | Where-Object { $_.caseId -like '*.upload-unicode-*' })
    if ($unicodeItems.Count -eq 2) {
        $searchTerm = 'ticketd-live-{0}-r{1:D2}-東京 same name.bin' -f $script:RunToken, $Round
        $search = Invoke-Ticketd -Arguments @('attachment', 'search', $searchTerm, '--state', 'all', '--limit', '20')
        $searchIds = @()
        $searchRowsUploadedCopy = $false
        if ($null -ne $search.Parsed) {
            $searchRows = @($search.Parsed)
            $searchIds = @($searchRows | ForEach-Object { [string]$_.attachment.id })
            $searchRowsUploadedCopy = $searchRows.Count -eq 2 -and @($searchRows | Where-Object { -not (Test-UploadedCopyTrue -Attachment $_.attachment) }).Count -eq 0
        }
        $expectedIds = @($unicodeItems | ForEach-Object { [string]$_.attachmentId } | Sort-Object)
        $actualIds = @($searchIds | Sort-Object)
        $searchPassed = $search.ExitCode -eq 0 -and $actualIds.Count -eq 2 -and (($actualIds -join ',') -eq ($expectedIds -join ',')) -and $searchRowsUploadedCopy
        $searchError = if ($searchPassed) { $null } elseif ($search.ErrorCode -like 'blocked_*') { $search.ErrorCode } elseif ($search.ExitCode -ne 0) { $search.ErrorCode } elseif (-not $searchRowsUploadedCopy) { 'uploaded_copy_missing_or_false' } else { 'search_result_mismatch' }
        $searchStatus = if ($searchError -like 'blocked_*') { 'blocked' } else { 'failed' }
        Add-Case -CaseId "$prefix.search-same-basename" -Status $(if ($searchPassed) { 'passed' } else { $searchStatus }) -Assertion 'Unique Unicode filename search returned exactly both same-basename files from separate directories, each projected as uploaded_copy=true.' -SizeBytes 90 -OutputPath 'workspace/attachment-search' -ErrorCode $searchError
    }
    else {
        Add-Case -CaseId "$prefix.search-same-basename" -Status 'skipped' -Assertion 'Skipped because both Unicode same-basename uploads were not confirmed.'
    }

    if ($uploaded.Count -eq 8 -and -not $script:AbortRemoteChecks) {
        $export = Invoke-Ticketd -Arguments @('export-markdown', '--ticket', $ticket, '--output', $exportRoot)
        $exportRootRelative = Join-Path (Split-Path -Leaf $script:OutputPath) (Join-Path ('round-{0:D2}' -f $Round) 'exports')
        $exportChecks = New-Object 'System.Collections.Generic.List[object]'
        if ($export.ExitCode -eq 0 -and $null -ne $export.Parsed -and $null -ne $export.Parsed.directory) {
            $directory = [string]$export.Parsed.directory
            foreach ($item in $uploaded) {
                $entry = @($export.Parsed.attachments | Where-Object { $_.attachment_id -eq $item.attachmentId }) | Select-Object -First 1
                $exportFile = $null
                $actualSize = $null
                $actualHash = $null
                if ($null -ne $entry -and $entry.kind -eq 'uploaded_copy' -and $entry.copy_status -eq 'unchanged' -and
                    -not [string]::IsNullOrWhiteSpace($entry.path) -and [string]::IsNullOrWhiteSpace($entry.omission)) {
                    $exportFile = Join-Path $directory ([string]$entry.path)
                    if ([System.IO.File]::Exists($exportFile)) {
                        $fileInfo = New-Object System.IO.FileInfo($exportFile)
                        $actualSize = [long]$fileInfo.Length
                        $actualHash = Get-FileSha256 -Path $exportFile
                    }
                }
                $match = $null -ne $entry -and $entry.kind -eq 'uploaded_copy' -and $entry.copy_status -eq 'unchanged' -and
                    $null -ne $actualSize -and $actualSize -eq $item.sizeBytes -and $actualHash -eq $item.sha256
                $outputRelative = if ($match) { Join-Path $exportRootRelative ([string]$entry.path) } else { $null }
                Add-Case -CaseId "$($item.caseId).normal-export-sha256-size" -Status $(if ($match) { 'passed' } else { 'failed' }) -Assertion 'Normal Markdown export produced bytes matching the synthetic input SHA-256 and size.' -RequestId $item.requestId -SizeBytes $item.sizeBytes -Sha256 $item.sha256 -AttachmentId $item.attachmentId -RemoteFileId $item.remoteFileId -OutputPath $outputRelative -ErrorCode $(if ($match) { $null } elseif ($null -eq $entry) { 'export_entry_missing' } elseif ($entry.copy_status) { "copy_$($entry.copy_status)" } else { 'export_bytes_mismatch' })
                $exportChecks.Add([pscustomobject]@{ item = $item; entry = $entry; path = $exportFile; matched = $match })
            }
            $allExportsPassed = $export.Parsed.status -eq 'complete' -and @($exportChecks | Where-Object { -not $_.matched }).Count -eq 0
            Add-Case -CaseId "$prefix.normal-export-hashes" -Status $(if ($allExportsPassed) { 'passed' } else { 'failed' }) -Assertion 'App Markdown export reported complete and every uploaded copy matched its recorded synthetic SHA-256 and size.' -OutputPath $exportRootRelative -ErrorCode $(if ($allExportsPassed) { $null } else { 'export_incomplete_or_mismatch' })
        }
        else {
            $errorCode = if ($export.ExitCode -ne 0) { $export.ErrorCode } else { 'invalid_export_result' }
            $status = if ($errorCode -like 'blocked_*') { 'blocked' } else { 'failed' }
            Add-Case -CaseId "$prefix.normal-export-hashes" -Status $status -Assertion 'Normal Markdown export did not produce a reportable bundle.' -OutputPath $exportRootRelative -ErrorCode $errorCode
            foreach ($item in $uploaded) {
                Add-Case -CaseId "$($item.caseId).normal-export-sha256-size" -Status 'skipped' -Assertion 'Skipped because normal Markdown export produced no bundle.' -RequestId $item.requestId -SizeBytes $item.sizeBytes -Sha256 $item.sha256 -AttachmentId $item.attachmentId -RemoteFileId $item.remoteFileId
            }
            $exportChecks = New-Object 'System.Collections.Generic.List[object]'
        }

        $singleExportItem = $uploaded | Where-Object { $_.caseId -like '*.upload-boundary-524411' } | Select-Object -First 1
        $singleExportPath = Join-Path $RoundRoot 'single-file-export-multichunk.bin'
        $singleExportRelative = Join-Path (Split-Path -Leaf $script:OutputPath) (Join-Path ('round-{0:D2}' -f $Round) 'single-file-export-multichunk.bin')
        $singleExport = Invoke-Ticketd -Arguments @('attachment', 'export', $singleExportItem.attachmentId, $singleExportPath)
        $singleExportSize = $null
        $singleExportSha256 = $null
        if ($singleExport.ExitCode -eq 0 -and [System.IO.File]::Exists($singleExportPath)) {
            $singleExportInfo = New-Object System.IO.FileInfo($singleExportPath)
            $singleExportSize = [long]$singleExportInfo.Length
            $singleExportSha256 = Get-FileSha256 -Path $singleExportPath
        }
        $singleExportPassed = $singleExport.ExitCode -eq 0 -and $singleExportSize -eq $singleExportItem.sizeBytes -and
            $singleExportSha256 -eq $singleExportItem.sha256
        $singleExportErrorCode = if ($singleExportPassed) { $null } elseif ($singleExport.ExitCode -ne 0) { $singleExport.ErrorCode } elseif (-not [System.IO.File]::Exists($singleExportPath)) { 'single_export_file_missing' } else { 'single_export_bytes_mismatch' }
        $singleExportStatus = if ($singleExportPassed) { 'passed' } elseif ($singleExportErrorCode -like 'blocked_*') { 'blocked' } else { 'failed' }
        Add-Case -CaseId "$prefix.single-file-export-sha256-size" -Status $singleExportStatus -Assertion 'Ordinary single-attachment export wrote the 524411-byte multichunk synthetic file with its exact original SHA-256 and size.' -RequestId $singleExportItem.requestId -SizeBytes $singleExportItem.sizeBytes -Sha256 $singleExportItem.sha256 -AttachmentId $singleExportItem.attachmentId -RemoteFileId $singleExportItem.remoteFileId -OutputPath $(if ($singleExportPassed) { $singleExportRelative } else { $null }) -ErrorCode $singleExportErrorCode

        $clobberItem = $uploaded | Where-Object { $_.caseId -like '*.upload-boundary-1' } | Select-Object -First 1
        $sentinelPath = Join-Path $RoundRoot 'existing-export-destination.bin'
        $sentinel = [System.Text.Encoding]::UTF8.GetBytes("ticketd-live-sentinel-$script:RunToken")
        [System.IO.File]::WriteAllBytes($sentinelPath, $sentinel)
        $noClobber = Invoke-Ticketd -Arguments @('attachment', 'export', $clobberItem.attachmentId, $sentinelPath)
        $sentinelAfter = [System.IO.File]::ReadAllBytes($sentinelPath)
        $sentinelUnchanged = ([System.BitConverter]::ToString($sentinelAfter)) -eq ([System.BitConverter]::ToString($sentinel))
        $noClobberPassed = $noClobber.ExitCode -ne 0 -and $noClobber.ErrorCode -eq 'destination_already_exists' -and $sentinelUnchanged
        $noClobberError = if ($noClobberPassed) { $null } elseif ($noClobber.ErrorCode -like 'blocked_*') { $noClobber.ErrorCode } elseif ($noClobber.ExitCode -eq 0) { 'unexpected_success' } elseif ($noClobber.ErrorCode -ne 'destination_already_exists') { 'expected_destination_exists_error' } elseif (-not $sentinelUnchanged) { 'sentinel_changed' } else { 'destination_exists_assertion_failed' }
        $noClobberStatus = if ($noClobberError -like 'blocked_*') { 'blocked' } else { 'failed' }
        Add-Case -CaseId "$prefix.export-no-clobber" -Status $(if ($noClobberPassed) { 'passed' } else { $noClobberStatus }) -Assertion 'Export returned the specific destination-exists error and preserved the preexisting sentinel bytes.' -RequestId $clobberItem.requestId -SizeBytes $clobberItem.sizeBytes -Sha256 $clobberItem.sha256 -AttachmentId $clobberItem.attachmentId -RemoteFileId $clobberItem.remoteFileId -OutputPath 'existing-export-destination.bin' -ErrorCode $noClobberError
    }
    else {
        Add-Case -CaseId "$prefix.normal-export-hashes" -Status 'skipped' -Assertion 'Skipped because all eight upload cases were not confirmed.'
        Add-Case -CaseId "$prefix.single-file-export-sha256-size" -Status 'skipped' -Assertion 'Skipped because the multichunk uploaded copy was not confirmed.'
        Add-Case -CaseId "$prefix.export-no-clobber" -Status 'skipped' -Assertion 'Skipped because a confirmed uploaded copy was unavailable.'
        foreach ($spec in $specs) {
            Add-Case -CaseId "$prefix.$($spec.caseId).normal-export-sha256-size" -Status 'skipped' -Assertion 'Skipped because normal export prerequisites were not met.' -SizeBytes $spec.sizeBytes -Sha256 $spec.sha256
        }
    }

    if ($uploaded.Count -eq 8 -and -not $script:AbortMutations) {
        $removeItem = $uploaded | Where-Object { $_.caseId -like '*.upload-boundary-0' } | Select-Object -First 1
        $detach = Invoke-Ticketd -Arguments @('attachment', 'detach', $removeItem.attachmentId, $ticket)
        $remove = $null
        if ($detach.ExitCode -eq 0) {
            $removeRequest = 'gdlive-{0}-r{1:D2}-remove' -f $script:RunToken, $Round
            $remove = Invoke-Ticketd -Arguments @('attachment', 'remove-from-ticketd', $removeItem.attachmentId, '--request-id', $removeRequest)
        }
        $removeStatus = Get-RequestStatus -RequestId $removeItem.requestId
        if ($remove.ExitCode -eq 0) {
            $oldReceipt = Invoke-Ticketd -Arguments (New-UploadArgumentList -InputPath $removeItem.inputPath -RequestId $removeItem.requestId)
            $afterOldReceipt = Get-RequestStatus -RequestId $removeItem.requestId
            $missingRecord = Invoke-Ticketd -Arguments @('attachment', 'inspect', $removeItem.attachmentId)
            $receiptDidNotResurrect = $oldReceipt.ExitCode -ne 0 -and $null -ne $afterOldReceipt -and
                $afterOldReceipt.record_removed -eq $true -and $afterOldReceipt.remote_file_id -eq $removeItem.remoteFileId -and
                $missingRecord.ExitCode -ne 0
            $reselect = Invoke-Ticketd -Arguments @('attachment', 'drive-add', $ConnectionId, $removeItem.remoteFileId)
            $reselected = $reselect.ExitCode -eq 0 -and $null -ne $reselect.Parsed -and $reselect.Parsed.id -eq $removeItem.attachmentId
            $removePassed = $detach.ExitCode -eq 0 -and $receiptDidNotResurrect -and $reselected
            $removeError = if ($removePassed) { $null } elseif ($detach.ExitCode -ne 0) { $detach.ErrorCode } elseif ($remove.ExitCode -ne 0) { $remove.ErrorCode } elseif ($oldReceipt.ExitCode -eq 0) { 'old_receipt_resurrected_record' } elseif (-not $receiptDidNotResurrect) { 'removal_state_mismatch' } else { $reselect.ErrorCode }
            Add-Case -CaseId "$prefix.remove-from-ticketd" -Status $(if ($removePassed) { 'passed' } else { 'failed' }) -Assertion 'Unused synthetic record was removed, its completed operation and remote file ID remained, old upload receipt did not recreate it, and explicit drive-add reselected the same remote file.' -RequestId $removeItem.requestId -SizeBytes $removeItem.sizeBytes -Sha256 $removeItem.sha256 -AttachmentId $removeItem.attachmentId -RemoteFileId $removeItem.remoteFileId -OutputPath 'workspace/drive-upload-status' -ErrorCode $removeError
        }
        else {
            $removeError = if ($detach.ExitCode -ne 0) { $detach.ErrorCode } elseif ($null -eq $remove) { 'remove_not_attempted' } else { $remove.ErrorCode }
            Add-Case -CaseId "$prefix.remove-from-ticketd" -Status $(if ($removeError -like 'blocked_*') { 'blocked' } else { 'failed' }) -Assertion 'Synthetic record could not be detached and removed safely.' -RequestId $removeItem.requestId -SizeBytes $removeItem.sizeBytes -Sha256 $removeItem.sha256 -AttachmentId $removeItem.attachmentId -RemoteFileId $removeItem.remoteFileId -ErrorCode $removeError
        }
    }
    else {
        Add-Case -CaseId "$prefix.remove-from-ticketd" -Status 'skipped' -Assertion 'Skipped because all uploads or safe mutation prerequisites were not confirmed.'
    }
}

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$targetRoot = Join-Path $repoRoot 'target\live-verification'
if (-not [System.IO.File]::Exists($script:CliPath)) { throw 'CliPath must identify an existing executable.' }
if ([string]::IsNullOrWhiteSpace($ConnectionId) -or [string]::IsNullOrWhiteSpace($FolderId)) { throw 'ConnectionId and FolderId are required; the runner never guesses a Drive account or folder.' }
if ($ConnectionId -notmatch '^[0-9a-fA-F-]{36}$' -or $FolderId -notmatch '^[A-Za-z0-9_-]+$') { throw 'ConnectionId or FolderId has an invalid shape.' }
if (-not [string]::IsNullOrWhiteSpace($ResourceKey) -and $ResourceKey -notmatch '^[A-Za-z0-9_-]+$') { throw 'ResourceKey has an invalid shape.' }

$runStamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$script:OutputPath = Join-Path $targetRoot ('google-drive-{0}-{1}' -f $runStamp, $script:RunId)
[System.IO.Directory]::CreateDirectory($script:OutputPath) | Out-Null

$savedEnvironment = @{}
foreach ($name in @('TICKETD_TEST_WORKSPACE', 'TICKETD_GOOGLE_OAUTH_CLIENT_FILE', 'TICKETD_GOOGLE_OAUTH_CLIENT_JSON')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

$startedAt = [DateTime]::UtcNow.ToString('o')
$fatal = $null
$runnerErrorCode = $null
$runnerErrorLine = $null
$runnerErrorMessage = $null
try {
    for ($round = 1; $round -le $Rounds; $round++) {
        $roundRoot = Join-Path $script:OutputPath ('round-{0:D2}' -f $round)
        [System.IO.Directory]::CreateDirectory($roundRoot) | Out-Null
        Invoke-Round -Round $round -RoundRoot $roundRoot
    }
}
catch {
    $fatal = 'runner_error'
    $runnerErrorLine = $_.InvocationInfo.ScriptLineNumber
    $runnerErrorCode = if ($_.Exception.Message -match '(?i)argument types do not match') { 'powershell_argument_type_mismatch' } else { 'runner_exception' }
    $runnerErrorMessage = [string]$_.Exception.Message
    if (-not [string]::IsNullOrWhiteSpace($script:OutputPath)) {
        $runnerErrorMessage = $runnerErrorMessage.Replace($script:OutputPath, '[run-artifact]')
    }
    $runnerErrorMessage = [regex]::Replace($runnerErrorMessage, '(?i)https?://\S+', '[url-redacted]')
    $runnerErrorMessage = [regex]::Replace($runnerErrorMessage, '(?i)(token|secret|authorization|code)=?[^\s,;]+', '$1=[redacted]')
    Add-Case -CaseId 'runner' -Status 'failed' -Assertion 'The runner stopped before completing the suite.' -ErrorCode $runnerErrorCode
}
finally {
    foreach ($name in $savedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
}

$caseArray = $script:Cases.ToArray()
$remoteFileArray = $script:RemoteFiles.ToArray()
$failed = @($caseArray | Where-Object { $_.status -eq 'failed' }).Count
$blocked = @($caseArray | Where-Object { $_.status -eq 'blocked' }).Count
$passed = @($caseArray | Where-Object { $_.status -eq 'passed' }).Count
$skipped = @($caseArray | Where-Object { $_.status -eq 'skipped' }).Count
$summary = if ($failed -gt 0) { 'failed' } elseif ($blocked -gt 0 -or $skipped -gt 0) { 'blocked' } else { 'passed' }
$gitHead = $null
$gitDirty = $null
try {
    $gitHead = (& git -C $repoRoot rev-parse HEAD 2>$null | Select-Object -First 1)
    $gitStatus = @(& git -C $repoRoot status --porcelain 2>$null)
    $gitDirty = $gitStatus.Count -gt 0
}
catch {
    $gitHead = 'unavailable'
    $gitDirty = $null
}
$cliHash = (Get-FileHash -LiteralPath $script:CliPath -Algorithm SHA256).Hash.ToLowerInvariant()
$report = [pscustomobject][ordered]@{
    formatVersion = 1
    suite = 'google-drive-live'
    runId = $script:RunId
    summary = $summary
    rounds = $Rounds
    startedAtUtc = $startedAt
    finishedAtUtc = [DateTime]::UtcNow.ToString('o')
    cliPath = $script:CliPath
    cliSha256 = $cliHash
    sourceHead = $gitHead
    sourceDirty = $gitDirty
    requireUploadedCopyClassification = [bool]$RequireUploadedCopyClassification
    runnerErrorCode = $runnerErrorCode
    runnerErrorLine = $runnerErrorLine
    runnerErrorMessage = $runnerErrorMessage
    reportPath = (Join-Path (Split-Path -Leaf $script:OutputPath) 'report.json')
    remoteCreatedFileCount = $remoteFileArray.Count
    remoteFiles = $remoteFileArray
    totals = [pscustomobject]@{ passed = $passed; failed = $failed; blocked = $blocked; skipped = $skipped }
    cases = $caseArray
}
$json = ConvertTo-Json -InputObject $report -Depth 10
$encoding = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $script:OutputPath 'report.json'), $json, $encoding)

[pscustomobject]@{
    summary = $summary
    reportPath = (Join-Path $script:OutputPath 'report.json')
    remoteCreatedFileCount = $script:RemoteFiles.Count
    passed = $passed
    failed = $failed
    blocked = $blocked
    skipped = $skipped
} | ConvertTo-Json -Compress

if ($failed -gt 0) { exit 1 }
if ($blocked -gt 0 -or $skipped -gt 0) { exit 2 }
exit 0
