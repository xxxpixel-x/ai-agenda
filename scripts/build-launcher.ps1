param([switch]$DesktopShortcut)

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$package = [System.IO.File]::ReadAllText((Join-Path $projectRoot 'package.json')) | ConvertFrom-Json
$launcherPath = Join-Path $projectRoot ($package.productName + '.exe')
$iconPath = Join-Path $projectRoot 'electron\icon.ico'
$sourcePath = Join-Path $projectRoot 'electron\launcher.cs'
$compiler = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if (!$compiler) {
    throw 'The Windows .NET Framework C# compiler was not found. Enable .NET Framework 4.8 and retry.'
}

# winexe opens without a console. Compile with the app icon using Windows' built-in compiler.
& $compiler /nologo /target:winexe /platform:anycpu /optimize+ /codepage:65001 /utf8output `
    /reference:System.Windows.Forms.dll "/win32icon:$iconPath" "/out:$launcherPath" $sourcePath
if ($LASTEXITCODE -ne 0) { throw "Launcher compilation failed (exit $LASTEXITCODE)." }
Write-Host "Created: $launcherPath"

if ($DesktopShortcut) {
    $desktopPath = [Environment]::GetFolderPath('DesktopDirectory')
    if (!$desktopPath) { throw 'The Windows desktop folder could not be found.' }
    $shortcutPath = Join-Path $desktopPath ($package.productName + '.lnk')
    $wsh = New-Object -ComObject WScript.Shell
    try {
        $shortcut = $wsh.CreateShortcut($shortcutPath)
        if ((Test-Path -LiteralPath $shortcutPath) -and $shortcut.TargetPath -ne $launcherPath) {
            throw "An unrelated shortcut already exists: $shortcutPath"
        }
        $shortcut.TargetPath = $launcherPath
        $shortcut.WorkingDirectory = $projectRoot
        $shortcut.IconLocation = "$launcherPath,0"
        $shortcut.Description = $package.productName
        $shortcut.Save()
        Write-Host "Created desktop shortcut: $shortcutPath"
    }
    finally {
        if ($shortcut) { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
        [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($wsh)
    }
}
