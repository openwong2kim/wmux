# A named-pipe server for broker-pipe-owner.yml, run as the temporary second
# account. It creates the pipe (so that account owns it), lets the runner's
# account open it, accepts one client, counts the bytes that client sends
# until it closes, and writes the result as JSON.
#
# Windows PowerShell 5.1 (.NET Framework: NamedPipeServerStream takes a
# PipeSecurity there).
param(
  [Parameter(Mandatory)] [string] $PipeName,
  [Parameter(Mandatory)] [string] $AllowSid,
  [Parameter(Mandatory)] [string] $ReadyPath,
  [Parameter(Mandatory)] [string] $ResultPath,
  [int] $TimeoutSeconds = 120
)
$ErrorActionPreference = 'Stop'

function Write-Result([hashtable] $result) {
  $json = $result | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText("$ResultPath.tmp", $json)
  Move-Item -LiteralPath "$ResultPath.tmp" -Destination $ResultPath -Force
}

try {
  $short = $PipeName -replace '^\\\\\.\\pipe\\', ''
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $security = New-Object System.IO.Pipes.PipeSecurity
  $security.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($me, 'FullControl', 'Allow')))
  $runner = New-Object System.Security.Principal.SecurityIdentifier($AllowSid)
  $security.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($runner, 'FullControl', 'Allow')))
  $server = New-Object System.IO.Pipes.NamedPipeServerStream(
    $short, [System.IO.Pipes.PipeDirection]::InOut, 1,
    [System.IO.Pipes.PipeTransmissionMode]::Byte, [System.IO.Pipes.PipeOptions]::Asynchronous,
    65536, 65536, $security)
  $owner = $server.GetAccessControl().GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  [System.IO.File]::WriteAllText($ReadyPath, $me.Value)

  $wait = $server.BeginWaitForConnection($null, $null)
  if (-not $wait.AsyncWaitHandle.WaitOne([TimeSpan]::FromSeconds($TimeoutSeconds))) {
    Write-Result @{ connected = $false; bytes = 0; owner = $owner; account = $me.Value; note = 'no client' }
    exit 0
  }
  $server.EndWaitForConnection($wait)

  $total = 0
  $buffer = New-Object byte[] 4096
  $end = 'eof'
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ($true) {
    $read = $server.BeginRead($buffer, 0, $buffer.Length, $null, $null)
    $left = $deadline - [DateTime]::UtcNow
    if ($left -le [TimeSpan]::Zero -or -not $read.AsyncWaitHandle.WaitOne($left)) { $end = 'timeout'; break }
    try { $n = $server.EndRead($read) } catch { $end = $_.Exception.GetType().Name; break }
    if ($n -le 0) { break }
    $total += $n
  }
  Write-Result @{ connected = $true; bytes = $total; owner = $owner; account = $me.Value; end = $end }
  $server.Dispose()
} catch {
  Write-Result @{ connected = $false; bytes = -1; error = $_.Exception.Message }
  exit 1
}
