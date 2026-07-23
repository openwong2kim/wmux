$ErrorActionPreference = 'Stop'

$packageName = 'fmux'

[array]$keys = Get-UninstallRegistryKey -SoftwareName 'fmux*'

if ($keys.Count -eq 1) {
  $keys | ForEach-Object {
    $silentArgs = '--uninstall --silent'
    Uninstall-ChocolateyPackage -PackageName $packageName `
                                -FileType 'exe' `
                                -SilentArgs $silentArgs `
                                -File $_.UninstallString.Replace('"','')
  }
} elseif ($keys.Count -eq 0) {
  Write-Warning "$packageName has already been uninstalled by other means."
} elseif ($keys.Count -gt 1) {
  Write-Warning "$($keys.Count) matches found!"
  Write-Warning "The following keys were found. To prevent data loss, no programs will be uninstalled."
  $keys | ForEach-Object { Write-Warning "- $($_.DisplayName)" }
}
