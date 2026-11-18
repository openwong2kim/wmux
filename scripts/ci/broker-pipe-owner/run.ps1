# broker-pipe-owner.yml: the MCP broker's Windows pipe as seen from a second
# local account. Runs in Windows PowerShell 5.1 on a CI runner.
#
#   (a) Pipe owner: a pipe at the broker's name, created by another account.
#       wmux-native mcp-shim must fall back with "broker not ours" and write
#       nothing to it. A control first runs the same shim against a pipe this
#       account owns, which must receive the handshake, so the check's zero
#       bytes mean the owner check and not a shim that never dialled.
#   (b) Owner-only access: the native listener (terminal core,
#       pipe-listener-v1) runs as this account. A client running as this
#       account opens it read-only (control); a client running as the other
#       account is refused a read-only open with access denied. Read-only,
#       because a default access list lets every account read: only the
#       owner-only list refuses it.
#
# -SameUserOnly runs only the controls, with no second account: the form a
# developer machine may run. Without it the script creates a temporary local
# account and removes it (and its profile) when done; the workflow's always()
# step removes it too if this script is cut short. Only for CI runners.
param(
  [Parameter(Mandatory)] [string] $ShimExe,
  [Parameter(Mandatory)] [string] $CoreModule,
  [Parameter(Mandatory)] [string] $WorkDir,
  [switch] $SameUserOnly
)
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$failures = New-Object System.Collections.Generic.List[string]
function Fail([string] $why) { Write-Host "FAIL: $why"; $script:failures.Add($why) }
function Pass([string] $what) { Write-Host "ok: $what" }

# Start-Process joins ArgumentList with spaces and does not quote it (5.1).
function Quote([string[]] $items) { $items | ForEach-Object { '"' + $_ + '"' } }

function Wait-File([string] $path, [int] $seconds, [System.Diagnostics.Process] $process) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while (-not (Test-Path -LiteralPath $path)) {
    if ((Get-Date) -gt $deadline) { throw "timed out waiting for $path" }
    if ($process -and $process.HasExited) {
      Start-Sleep -Milliseconds 200
      if (-not (Test-Path -LiteralPath $path)) { throw "the process for $path exited ($($process.ExitCode)) before writing it" }
    }
    Start-Sleep -Milliseconds 100
  }
}

function Read-Json([string] $path) { Get-Content -LiteralPath $path -Raw | ConvertFrom-Json }

function New-Password {
  $bytes = New-Object byte[] 24
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  # Every character class, so any complexity policy accepts it.
  'Aa1!' + [Convert]::ToBase64String($bytes)
}

$started = New-Object System.Collections.Generic.List[System.Diagnostics.Process]

# A PowerShell 5.1 helper script, as this account or as $Credential.
function Start-Helper([string] $script, [string[]] $arguments, $credential) {
  $argv = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $WorkDir $script)) + $arguments
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $options = @{ FilePath = $ps; ArgumentList = (Quote $argv); WorkingDirectory = $WorkDir; PassThru = $true; WindowStyle = 'Hidden' }
  if ($credential) { $options.Credential = $credential; $options.LoadUserProfile = $true }
  $p = Start-Process @options
  $script:started.Add($p)
  $p
}

# wmux-native mcp-shim with an isolated home and data suffix: its stderr
# lines. stdin is closed at once; the shim reads none before the broker acks.
function Invoke-Shim([string] $shimHome, [string] $suffix) {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $script:shimCopy
  $info.Arguments = 'mcp-shim'
  $info.UseShellExecute = $false
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.CreateNoWindow = $true
  $info.EnvironmentVariables['USERPROFILE'] = $shimHome
  $info.EnvironmentVariables['HOME'] = $shimHome
  $info.EnvironmentVariables['WMUX_DATA_SUFFIX'] = $suffix
  $info.EnvironmentVariables.Remove('WMUX_AUTH_TOKEN')
  $p = [System.Diagnostics.Process]::Start($info)
  $p.StandardInput.Close()
  $err = $p.StandardError.ReadToEndAsync()
  $out = $p.StandardOutput.ReadToEndAsync()
  if (-not $p.WaitForExit(60000)) { $p.Kill(); throw 'mcp-shim did not exit within 60 s' }
  [pscustomobject]@{ code = $p.ExitCode; stderr = $err.Result; stdout = $out.Result }
}

# A shim home holding the auth token for $suffix (so the shim dials), and no
# broker-off marker.
function New-ShimHome([string] $suffix) {
  $shimHome = Join-Path $WorkDir ("home" + $suffix)
  New-Item -ItemType Directory -Force -Path $shimHome | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $shimHome ".wmux$suffix-auth-token"), 'ci-placeholder-token')
  $shimHome
}

function New-Suffix { '-ci' + ([guid]::NewGuid().ToString('N').Substring(0, 8)) }

$runnerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
# The shim names the pipe after GetUserNameW, as Environment.UserName does.
$runnerName = [Environment]::UserName

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
foreach ($f in 'foreign-pipe-server.ps1', 'pipe-client.ps1', 'native-listener.mjs') {
  Copy-Item -LiteralPath (Join-Path $here $f) -Destination (Join-Path $WorkDir $f) -Force
}
# A copy of the shim with no bundle beside it: after its fallback line it
# exits instead of starting the full server.
$shimDir = Join-Path $WorkDir 'shim'
New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
$script:shimCopy = Join-Path $shimDir 'wmux-native.exe'
Copy-Item -LiteralPath $ShimExe -Destination $script:shimCopy -Force

$userName = $null
$credential = $null
$userSid = $null
try {
  # ----- (a) control: a pipe this account owns receives the handshake --------
  $suffix = New-Suffix
  $pipe = "\\.\pipe\wmux-mcpb$suffix-$runnerName"
  $ready = Join-Path $WorkDir 'a-control.ready'
  $result = Join-Path $WorkDir 'a-control.json'
  $server = Start-Helper 'foreign-pipe-server.ps1' @('-PipeName', $pipe, '-AllowSid', $runnerSid, '-ReadyPath', $ready, '-ResultPath', $result, '-TimeoutSeconds', '60') $null
  Wait-File $ready 60 $server
  $shim = Invoke-Shim (New-ShimHome $suffix) $suffix
  Write-Host "control shim (exit $($shim.code)) stderr: $($shim.stderr.Trim())"
  Wait-File $result 60 $server
  $r = Read-Json $result
  if ($r.connected -and $r.bytes -gt 0) { Pass "control: the shim wrote $($r.bytes) bytes to a pipe this account owns" }
  else { Fail "control: the shim did not reach a pipe this account owns ($(Get-Content -LiteralPath $result -Raw))" }
  if ($shim.stderr -match 'broker not ours') { Fail 'control: the shim called a pipe this account owns not ours' }

  # ----- (b) control: this account opens the native listener's pipe ---------
  $nativePipe = "\\.\pipe\wmux-ci-native-listener-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
  $lReady = Join-Path $WorkDir 'b.ready'
  $lResult = Join-Path $WorkDir 'b.json'
  $lStop = Join-Path $WorkDir 'b.stop'
  $node = (Get-Command node).Source
  $listener = Start-Process -FilePath $node -ArgumentList (Quote @((Join-Path $WorkDir 'native-listener.mjs'), $CoreModule, $nativePipe, $lReady, $lResult, $lStop)) -PassThru -WindowStyle Hidden
  $started.Add($listener)
  Wait-File $lReady 60 $listener
  $cResult = Join-Path $WorkDir 'b-control.json'
  $client = Start-Helper 'pipe-client.ps1' @('-PipeName', $nativePipe, '-ResultPath', $cResult, '-Direction', 'In') $null
  Wait-File $cResult 60 $client
  $c = Read-Json $cResult
  if ($c.result -eq 'connected') { Pass 'control: this account opens the native listener''s pipe read-only' }
  else { Fail "control: this account could not open the native listener's pipe ($(Get-Content -LiteralPath $cResult -Raw))" }

  if (-not $SameUserOnly) {
    # ----- the temporary second account -------------------------------------
    $userName = 'wmuxci' + ([guid]::NewGuid().ToString('N').Substring(0, 8))
    if ($env:GITHUB_ENV) { Add-Content -LiteralPath $env:GITHUB_ENV -Value "BROKER_PIPE_OWNER_USER=$userName" }
    $password = New-Password
    Write-Host "::add-mask::$password"
    $secure = ConvertTo-SecureString $password -AsPlainText -Force
    New-LocalUser -Name $userName -Password $secure -AccountNeverExpires -PasswordNeverExpires -Description 'wmux CI temporary account' | Out-Null
    Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $userName
    $userSid = (Get-LocalUser -Name $userName).SID.Value
    $credential = New-Object System.Management.Automation.PSCredential(".\$userName", $secure)
    # The helpers run from, and write their results to, the work directory.
    & icacls.exe $WorkDir /grant "*${userSid}:(OI)(CI)M" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls exited $LASTEXITCODE" }
    Write-Host "created a temporary account ($userSid)"

    # ----- (a) a pipe at the broker's name owned by the other account -------
    $suffix = New-Suffix
    $pipe = "\\.\pipe\wmux-mcpb$suffix-$runnerName"
    $ready = Join-Path $WorkDir 'a.ready'
    $result = Join-Path $WorkDir 'a.json'
    $server = Start-Helper 'foreign-pipe-server.ps1' @('-PipeName', $pipe, '-AllowSid', $runnerSid, '-ReadyPath', $ready, '-ResultPath', $result, '-TimeoutSeconds', '60') $credential
    Wait-File $ready 90 $server
    $serverSid = (Get-Content -LiteralPath $ready -Raw).Trim()
    if ($serverSid -ne $userSid) { Fail "the pipe server runs as $serverSid, not as the temporary account" }
    $shim = Invoke-Shim (New-ShimHome $suffix) $suffix
    Write-Host "shim (exit $($shim.code)) stderr: $($shim.stderr.Trim())"
    if ($shim.stderr -match '\[wmux-mcp-shim\] broker not ours') { Pass 'the shim fell back with "broker not ours"' }
    else { Fail "the shim did not report a pipe owned by another account: $($shim.stderr.Trim())" }
    if ($shim.stdout.Length -gt 0) { Fail "the shim wrote to stdout: $($shim.stdout)" }
    Wait-File $result 90 $server
    $r = Read-Json $result
    if ($r.owner -ne $userSid) { Fail "the pipe's owner is $($r.owner), not the temporary account" }
    if (-not $r.connected) { Fail "the shim never opened the other account's pipe ($(Get-Content -LiteralPath $result -Raw))" }
    elseif ($r.bytes -ne 0) { Fail "the shim wrote $($r.bytes) bytes to a pipe another account owns" }
    # Zero bytes count only when the server read until the shim closed its
    # end; a read that timed out or failed observed nothing.
    elseif ($r.end -ne 'eof') { Fail "incomplete observation: the server's read ended with '$($r.end)', not at the shim's close" }
    else { Pass 'the shim opened the other account''s pipe and wrote nothing' }

    # ----- (b) the other account cannot open the native listener's pipe -----
    $uResult = Join-Path $WorkDir 'b-user.json'
    $client = Start-Helper 'pipe-client.ps1' @('-PipeName', $nativePipe, '-ResultPath', $uResult, '-Direction', 'In') $credential
    Wait-File $uResult 90 $client
    $u = Read-Json $uResult
    if ($u.account -ne $userSid) { Fail "the client ran as $($u.account), not as the temporary account" }
    if ($u.result -eq 'access-denied') { Pass 'the other account is refused a read-only open of the native listener''s pipe (access denied)' }
    else { Fail "the other account got '$($u.result)' opening the native listener's pipe: $($u.detail)" }
  }

  New-Item -ItemType File -Force -Path $lStop | Out-Null
  Wait-File $lResult 30 $listener
  $l = Read-Json $lResult
  $accepted = @($l.accepted)
  if ($accepted.Count -ne 1) { Fail "the native listener accepted $($accepted.Count) connections, expected the control's one" }
  elseif ($accepted[0].sameUser -ne $true) { Fail "the control's peer was not read as this account: $($accepted[0] | ConvertTo-Json -Compress)" }
  else { Pass 'the native listener accepted only the control, read as this account' }
  if ($l.failure) { Fail "the native listener stopped accepting: $($l.failure)" }
} finally {
  foreach ($p in $started) {
    try { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force } } catch { Write-Host "could not stop $($p.Id): $($_.Exception.Message)" }
  }
  if ($userName) {
    try { Remove-LocalUser -Name $userName } catch { Write-Host "could not remove the temporary account: $($_.Exception.Message)" }
    if ($userSid) {
      Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $userSid } | ForEach-Object {
        try { Remove-CimInstance -InputObject $_ } catch { Write-Host "could not remove the temporary profile: $($_.Exception.Message)" }
      }
    }
  }
}

if ($failures.Count -gt 0) {
  Write-Host "$($failures.Count) check(s) failed"
  exit 1
}
Write-Host 'all checks passed'
