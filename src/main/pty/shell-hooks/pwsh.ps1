# wmux shell integration hook for PowerShell 5.1 / 7+
# Emits OSC 7 (CWD) and OSC 7727 (git branch) on every prompt render.

if ($env:WMUX_SHELL_HOOK_ACTIVE -eq '1') { return }
$env:WMUX_SHELL_HOOK_ACTIVE = '1'

# Constrained Language Mode (AppLocker / WDAC) blocks .NET method calls on
# non-core types. Both [System.Net.Dns]::GetHostName() and [Console]::Write
# would throw "Method invocations are supported only on core types in this
# language mode" — and because PSReadLine renders the prompt on every
# keystroke, that surfaces as "Exception in custom key handler" on each key.
# Skip OSC emission entirely when not in FullLanguage mode.
$script:__wmux_skip_osc = $ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage'

# Preserve the original prompt so user customisations are not lost.
if (Test-Path Function:\prompt) {
    Copy-Item Function:\prompt Function:\__wmux_original_prompt
}

function prompt {
    if (-not $script:__wmux_skip_osc) {
        try {
            # --- OSC 7: Current Working Directory ---
            $cwd = (Get-Location).ProviderPath
            $hostname = $env:COMPUTERNAME
            # file:// URI with forward slashes
            $uri = 'file://' + $hostname + '/' + ($cwd -replace '\\', '/')
            [Console]::Write("`e]7;$uri`a")

            # --- OSC 7727: Git branch (best-effort) ---
            $gitExe = Get-Command git -ErrorAction SilentlyContinue
            if ($gitExe) {
                $branch = & git rev-parse --abbrev-ref HEAD 2>$null
                if ($LASTEXITCODE -eq 0 -and $branch) {
                    [Console]::Write("`e]7727;$branch`a")
                }
            }
        } catch {
            # OSC emission failed (constrained-mode edge case, console host
            # quirk, etc.) — disable for the rest of the session so we don't
            # spam errors on every prompt render.
            $script:__wmux_skip_osc = $true
        }
    }

    # Call original prompt to preserve user theme / starship / oh-my-posh etc.
    if (Test-Path Function:\__wmux_original_prompt) {
        return __wmux_original_prompt
    }
    return "PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) "
}
