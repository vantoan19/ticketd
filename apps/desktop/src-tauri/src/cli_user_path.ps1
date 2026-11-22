$ErrorActionPreference = 'Stop'

# Prepare the notification before editing the registry. Explorer uses it to
# refresh the environment inherited by newly opened terminals.
Add-Type -Namespace Ticketd -Name EnvironmentChange -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern System.IntPtr SendMessageTimeout(
    System.IntPtr window, uint message, System.UIntPtr wParam, string lParam,
    uint flags, uint timeout, out System.UIntPtr result);
'@

$directory = $env:TICKETD_CLI_DIRECTORY
if ([string]::IsNullOrEmpty($directory) -or $directory.Contains(';')) {
    throw 'The app folder cannot be added to PATH.'
}
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
    $path = $key.GetValue('Path', $null, 'DoNotExpandEnvironmentNames')
    $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
    if ($null -ne $path) {
        $kind = $key.GetValueKind('Path')
        if ($kind -notin 'String', 'ExpandString') {
            throw 'The current Windows user PATH is not a string.'
        }
    }
    $entries = $path -split ';'
    $alreadyPresent = $false
    foreach ($entry in $entries) {
        $entry = $entry.Trim().Trim('"')
        if ($kind -eq 'ExpandString') {
            $entry = [Environment]::ExpandEnvironmentVariables($entry)
        }
        if ($entry.TrimEnd([char[]]'\/') -eq $directory.TrimEnd([char[]]'\/')) {
            $alreadyPresent = $true
            break
        }
    }
    if (!$alreadyPresent) {
        $newPath = if (!$path) { $directory } else { "$($path.TrimEnd(';'));$directory" }
        $key.SetValue('Path', $newPath, $kind)
    }
} finally {
    $key.Dispose()
}

$result = [UIntPtr]::Zero
[void][Ticketd.EnvironmentChange]::SendMessageTimeout(
    [IntPtr]0xffff, 0x001a, [UIntPtr]::Zero, 'Environment', 0x0002, 1000, [ref]$result)
