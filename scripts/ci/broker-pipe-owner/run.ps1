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
#   (c) Integrity: the broker started at Medium integrity from this elevated
#       runner. An elevated client (this runner, High) is hosted and a tool
#       call answers, both from a plain client and through wmux-native
#       mcp-shim; a Low integrity client is refused when it opens the pipe.
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

# A file another process still has open for writing (the broker's log).
function Read-Shared([string] $path) {
  $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
  $stream = New-Object System.IO.FileStream($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)
  try { (New-Object System.IO.StreamReader($stream)).ReadToEnd() } finally { $stream.Dispose() }
}

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

# wmux-native mcp-shim for one MCP session: `$lines` go to its stdin, its
# stdout is read until the response with id `$waitId` (or 30 s), then stdin
# closes. Its stdout and stderr.
function Invoke-ShimSession([string] $shimHome, [string] $suffix, [string[]] $lines, [int] $waitId) {
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
  $err = $p.StandardError.ReadToEndAsync()
  $p.StandardInput.NewLine = "`n"
  foreach ($line in $lines) { $p.StandardInput.WriteLine($line) }
  $p.StandardInput.Flush()
  $stdout = New-Object System.Text.StringBuilder
  $deadline = (Get-Date).AddSeconds(30)
  $read = $null
  while ((Get-Date) -lt $deadline) {
    if (-not $read) { $read = $p.StandardOutput.ReadLineAsync() }
    if (-not $read.Wait(500)) { continue }
    $got = $read.Result
    $read = $null
    if ($null -eq $got) { break }
    [void]$stdout.AppendLine($got)
    if ($got -match ('"id":' + $waitId + '[,}]')) { break }
  }
  $p.StandardInput.Close()
  if (-not $p.WaitForExit(30000)) { $p.Kill(); $p.WaitForExit() }
  [pscustomobject]@{ code = $p.ExitCode; stderr = $err.Result; stdout = $stdout.ToString() }
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
$brokerPid = $null
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
  if ($r.owner -ne $runnerSid) { Fail "control: the pipe's owner is $($r.owner), not this account" }

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

    # ----- (c) integrity: a Medium broker, an elevated and a Low client -----
    . (Join-Path $here 'integrity.ps1')
    $ownRid = [IntegrityLaunch]::ProcessIntegrity($PID)
    if ($ownRid -lt 0x3000) {
      Fail ('the runner is not elevated (integrity 0x{0:x}); the integrity checks need it' -f $ownRid)
    } else {
      $iSuffix = New-Suffix
      $iHome = Join-Path $WorkDir 'ihome'
      New-Item -ItemType Directory -Force -Path $iHome | Out-Null
      $iToken = 'ci-integrity-' + [guid]::NewGuid().ToString('N')
      [System.IO.File]::WriteAllText((Join-Path $iHome ".wmux$iSuffix-auth-token"), $iToken)
      $iPipe = "\\.\pipe\wmux-mcpb$iSuffix-$runnerName"
      $brokerJs = Join-Path $WorkDir 'broker.cjs'
      & $node (Join-Path $here 'build-broker.mjs') $brokerJs
      if ($LASTEXITCODE -ne 0) { throw "build-broker.mjs exited $LASTEXITCODE" }
      $brokerLog = Join-Path $WorkDir 'broker.log'

      # The broker inherits this environment: point it at the throwaway home
      # and the built core for the launch only.
      $saved = @{}
      foreach ($k in 'USERPROFILE', 'HOME', 'WMUX_DATA_SUFFIX', 'WMUX_TERMINAL_CORE_MODULE', 'WMUX_AUTH_TOKEN') {
        $saved[$k] = [Environment]::GetEnvironmentVariable($k)
      }
      try {
        $env:USERPROFILE = $iHome
        $env:HOME = $iHome
        $env:WMUX_DATA_SUFFIX = $iSuffix
        $env:WMUX_TERMINAL_CORE_MODULE = $CoreModule
        Remove-Item Env:\WMUX_AUTH_TOKEN -ErrorAction SilentlyContinue
        $cmdExe = Join-Path $env:SystemRoot 'System32\cmd.exe'
        $brokerLine = '"' + $cmdExe + '" /d /s /c ""' + $node + '" "' + $brokerJs + '" 2> "' + $brokerLog + '""'
        $brokerPid = [IntegrityLaunch]::Start($brokerLine, $WorkDir, 'S-1-16-8192')
      } finally {
        foreach ($k in @($saved.Keys)) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
      }
      $brokerRid = [IntegrityLaunch]::ProcessIntegrity($brokerPid)
      if ($brokerRid -ne 0x2000) { Fail ('the broker runs at integrity 0x{0:x}, not Medium' -f $brokerRid) }
      $deadline = (Get-Date).AddSeconds(60)
      $log = ''
      while ($log -notmatch 'peer-pid: available') {
        if ((Get-Date) -gt $deadline) { throw "the Medium broker did not get ready: $log" }
        Start-Sleep -Milliseconds 200
        if (Test-Path -LiteralPath $brokerLog) { $log = (Read-Shared $brokerLog) }
      }
      Pass 'the broker runs at Medium integrity and its self-check passed'

      # An elevated plain client: hosted, initialize answered, a tool answers.
      $eResult = Join-Path $WorkDir 'c-elevated.json'
      & $node (Join-Path $here 'broker-client.mjs') $iPipe $iToken $eResult
      $e = Read-Json $eResult
      if ($e.ack.ok -eq $true -and $e.initialized -and $e.tool) { Pass 'an elevated client of the Medium broker is hosted and a tool answers' }
      else { Fail "elevated client: $(Get-Content -LiteralPath $eResult -Raw); broker log: $((Read-Shared $brokerLog))" }

      # The same through wmux-native mcp-shim, as an elevated agent pane runs it.
      $session = Invoke-ShimSession $iHome $iSuffix @(
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"broker-ci","version":"0"}}}',
        '{"jsonrpc":"2.0","method":"notifications/initialized"}',
        '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"repl_sessions","arguments":{}}}'
      ) 2
      Write-Host "elevated shim (exit $($session.code)) stderr: $($session.stderr.Trim())"
      # The tool call's response, parsed (its keys come in no fixed order).
      $answer = $session.stdout -split "`n" | Where-Object { $_.Trim() } | ForEach-Object {
        try { $_ | ConvertFrom-Json } catch { $null }
      } | Where-Object { $_ -and $_.id -eq 2 } | Select-Object -First 1
      if ($answer -and $answer.result -and -not $answer.result.isError -and $session.stderr -notmatch 'broker not ours|running the full') {
        Pass 'an elevated wmux-native mcp-shim is hosted by the Medium broker and a tool answers'
      } else {
        Fail "elevated shim: stdout $($session.stdout.Trim()); stderr $($session.stderr.Trim())"
      }

      # A Low integrity client: refused at open. Its result goes to a folder
      # labelled Low, the only kind it may write to.
      $lowDir = Join-Path $WorkDir 'low'
      New-Item -ItemType Directory -Force -Path $lowDir | Out-Null
      & icacls.exe $lowDir /setintegritylevel '(OI)(CI)low' | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "icacls exited $LASTEXITCODE" }
      $lowResult = Join-Path $lowDir 'c-low.json'
      $lowLine = '"' + $node + '" "' + (Join-Path $here 'broker-client.mjs') + '" "' + $iPipe + '" "-" "' + $lowResult + '" --open-only'
      [void][IntegrityLaunch]::Start($lowLine, $lowDir, 'S-1-16-4096')
      Wait-File $lowResult 60 $null
      $low = Read-Json $lowResult
      if (-not $low.connected -and ($low.error -eq 'EPERM' -or $low.error -eq 'EACCES')) { Pass "a Low integrity client is refused at open ($($low.error))" }
      else { Fail "a Low integrity client: $(Get-Content -LiteralPath $lowResult -Raw)" }
      if ((Read-Shared $brokerLog) -match 'peer refused') { Write-Host "broker log: $((Read-Shared $brokerLog))" }
    }
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
  # The Medium broker and the shell that started it, by pid.
  if ($brokerPid) { & taskkill.exe /PID $brokerPid /T /F | Out-Null }
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
