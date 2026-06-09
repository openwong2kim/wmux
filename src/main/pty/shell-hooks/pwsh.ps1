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
    $body = if (Test-Path Function:\__wmux_original_prompt) {
        __wmux_original_prompt
    } else {
        "PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) "
    }

    $oscPrefix = ''
    if (-not $script:__wmux_skip_osc) {
        try {
            # ESC / BEL as [char] codes, NOT the PowerShell `e / `a escapes.
            # The `e escape (escape char) only exists in PowerShell 6+. Under
            # Windows PowerShell 5.1 "`e" is the literal two-char string and
            # collapses to "e", so the prompt would emit visible `e]7;...` text
            # instead of a real OSC 7 sequence — a garbled prompt plus broken
            # cwd reporting, and the stray glyphs throw off the cursor baseline
            # that in-pane TUIs (codex, Claude Code) render against. [char]27 /
            # [char]7 work on 5.1 and 7+, matching the OSC 133 hook in
            # daemon/shell-integration.ts.
            $esc = [char]27
            $bel = [char]7

            # --- OSC 7: Current Working Directory ---
            $cwd = (Get-Location).ProviderPath
            $hostname = $env:COMPUTERNAME
            # file:// URI with forward slashes
            $uri = 'file://' + $hostname + '/' + ($cwd -replace '\\', '/')
            $oscPrefix += "$esc]7;$uri$bel"

            # --- OSC 7727: Git branch (best-effort) ---
            $gitExe = Get-Command git -ErrorAction SilentlyContinue
            if ($gitExe) {
                $branch = & git rev-parse --abbrev-ref HEAD 2>$null
                if ($LASTEXITCODE -eq 0 -and $branch) {
                    $oscPrefix += "$esc]7727;$branch$bel"
                }
            }
        } catch {
            # OSC emission failed (constrained-mode edge case, console host
            # quirk, etc.) — disable for the rest of the session so we don't
            # spam errors on every prompt render.
            $script:__wmux_skip_osc = $true
        }
    }

    return $oscPrefix + [string]$body
}
