$ErrorActionPreference = 'Stop'

$version = $env:chocolateyPackageVersion
$url     = "https://github.com/skflowne/fmux/releases/download/v${version}/fmux-${version}.Setup.exe"

$packageArgs = @{
  packageName    = 'fmux'
  fileType       = 'exe'
  url64bit       = $url
  checksum64     = '__CHECKSUM_SHA256__'
  checksumType64 = 'sha256'
  silentArgs     = '--silent'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
