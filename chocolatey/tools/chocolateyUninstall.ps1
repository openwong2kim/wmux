$ErrorActionPreference = 'Stop'

$packageName = 'wmux'
$expectedInstallDir = Join-Path $env:LOCALAPPDATA $packageName
$expectedUninstaller = Join-Path $expectedInstallDir 'Update.exe'

[array]$keys = Get-UninstallRegistryKey -SoftwareName $packageName |
  Where-Object { $_.DisplayName -eq $packageName }

if ($keys.Count -eq 1) {
  if (-not (Test-Path -LiteralPath $expectedUninstaller -PathType Leaf)) {
    Write-Warning "$packageName uninstaller was not found at the expected location: $expectedUninstaller"
    return
  }

  $resolvedInstallDir = [System.IO.Path]::GetFullPath($expectedInstallDir).TrimEnd('\')
  $resolvedUninstaller = [System.IO.Path]::GetFullPath((Get-Item -LiteralPath $expectedUninstaller).FullName)

  if (-not $resolvedUninstaller.StartsWith($resolvedInstallDir + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-Warning "$packageName uninstaller resolved outside the expected install location: $resolvedUninstaller"
    return
  }

  $silentArgs = '--uninstall --silent'
  Uninstall-ChocolateyPackage -PackageName $packageName `
                              -FileType 'exe' `
                              -SilentArgs $silentArgs `
                              -File $resolvedUninstaller
} elseif ($keys.Count -eq 0) {
  Write-Warning "$packageName has already been uninstalled by other means."
} elseif ($keys.Count -gt 1) {
  Write-Warning "$($keys.Count) matches found!"
  Write-Warning "The following keys were found. To prevent data loss, no programs will be uninstalled."
  $keys | ForEach-Object { Write-Warning "- $($_.DisplayName)" }
}
