# A named-pipe client for broker-pipe-owner.yml: opens the pipe for reading
# and writing and writes how that went as JSON: "connected", "access-denied",
# "not-found" (no instance within the timeout) or "error".
#
# Run as the runner's account it is the control (the listener is up and the
# name is right); run as the temporary second account it is the check.
param(
  [Parameter(Mandatory)] [string] $PipeName,
  [Parameter(Mandatory)] [string] $ResultPath,
  [int] $TimeoutMs = 10000
)
$ErrorActionPreference = 'Stop'

$short = $PipeName -replace '^\\\\\.\\pipe\\', ''
$account = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $short, [System.IO.Pipes.PipeDirection]::InOut)
$result = @{ account = $account }
try {
  $client.Connect($TimeoutMs)
  $bytes = [System.Text.Encoding]::ASCII.GetBytes("ping`n")
  $client.Write($bytes, 0, $bytes.Length)
  $client.Flush()
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
