param([string]$environmentKey = 'Environment')

$ErrorActionPreference = 'Stop'

# Prepare the Explorer notification in memory. Windows PowerShell's Add-Type
# compiles through TEMP, which can fail before the PATH write.
$name = [Reflection.AssemblyName]::new('Ticketd.EnvironmentChange')
$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly(
    $name, [Reflection.Emit.AssemblyBuilderAccess]::Run)
$module = $assembly.DefineDynamicModule($name.Name)
$type = $module.DefineType('Ticketd.EnvironmentChange', 'Public')
$parameterTypes = [Type[]]@(
    [IntPtr], [uint32], [UIntPtr], [string], [uint32], [uint32], [UIntPtr].MakeByRefType()
)
$method = $type.DefinePInvokeMethod(
    'SendMessageTimeoutW', 'user32.dll', 'Public, Static, PinvokeImpl', 'Standard',
    [IntPtr], $parameterTypes, 'Winapi', 'Unicode')
$method.SetImplementationFlags(
    $method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
$environmentChange = $type.CreateType()

$directory = $env:TICKETD_CLI_DIRECTORY
if ([string]::IsNullOrEmpty($directory) -or $directory.Contains(';')) {
    throw 'The app folder cannot be added to PATH.'
}
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($environmentKey)
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
[void]$environmentChange::SendMessageTimeoutW(
    [IntPtr]0xffff, 0x001a, [UIntPtr]::Zero, 'Environment', 0x0002, 1000, [ref]$result)
