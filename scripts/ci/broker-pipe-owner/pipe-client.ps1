# A named-pipe client for broker-pipe-owner.yml: opens the pipe and writes
# how that went as JSON: "connected", "access-denied", "not-found" (no
# instance within the timeout) or "error".
#
# Read-only (In) by default: a pipe's default access list lets every account
# read, so only an owner-only list refuses a read-only open. A refused
# read-only open is therefore evidence of the owner-only list, where a
# refused read-write open would not be.
#
# Run as the runner's account it is the control (the listener is up and the
# name is right); run as the temporary second account it is the check.
param(
  [Parameter(Mandatory)] [string] $PipeName,
  [Parameter(Mandatory)] [string] $ResultPath,
  [ValidateSet('In', 'InOut')] [string] $Direction = 'In',
  [int] $TimeoutMs = 10000
)
$ErrorActionPreference = 'Stop'

$short = $PipeName -replace '^\\\\\.\\pipe\\', ''
$account = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $short, [System.IO.Pipes.PipeDirection]::$Direction)
$result = @{ account = $account; direction = $Direction }
try {
  $client.Connect($TimeoutMs)
  if ($Direction -eq 'InOut') {
    $bytes = [System.Text.Encoding]::ASCII.GetBytes("ping`n")
    $client.Write($bytes, 0, $bytes.Length)
    $client.Flush()
  }
  $result.result = 'connected'
} catch [System.UnauthorizedAccessException] {
  $result.result = 'access-denied'
  $result.detail = $_.Exception.Message
} catch [System.TimeoutException] {
  $result.result = 'not-found'
  $result.detail = $_.Exception.Message
} catch {
  $result.result = 'error'
  $result.detail = "$($_.Exception.GetType().FullName): $($_.Exception.Message)"
} finally {
  $client.Dispose()
}
$json = $result | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText("$ResultPath.tmp", $json)
Move-Item -LiteralPath "$ResultPath.tmp" -Destination $ResultPath -Force
