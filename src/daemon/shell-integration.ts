import * as fs from 'node:fs';
import * as path from 'node:path';
import { getWmuxDir } from './config';

/**
 * Shell integration installer: materializes OSC 133 init scripts into
 * ~/.wmux/shell-integration/ so that spawned PTYs can source them
 * regardless of whether wmux runs from a packaged Electron asar bundle or
 * a dev tree. Scripts are versioned; if the on-disk copy is stale (or
 * missing) we overwrite it.
 *
 * Coverage:
 *   - PowerShell 5.1 / 7+  (powershell.exe, pwsh.exe)
 *   - Bash 4.4+            (Git Bash, WSL)
 *
 * Explicitly NOT covered:
 *   - cmd.exe              (no prompt hook, OSC 133 is a no-op there)
 *   - zsh / fish           (v3 roadmap)
 */

const INTEGRATION_VERSION = 2;
const VERSION_FILE = '.version';

// -----------------------------------------------------------------------
// PowerShell (pwsh 7+ and Windows PowerShell 5.1) — uses PSReadLine hook
// for the command_start marker and prompt function for A/B/D.
// -----------------------------------------------------------------------
const PWSH_INIT = `# wmux shell integration — OSC 133 semantic markers (v${INTEGRATION_VERSION})
# Emits prompt/command boundaries so wmux's daemon can index command output
# without parsing a scrollback viewport.

if ($env:WMUX_SHELL_INTEGRATION -eq '0') { return }

# Constrained Language Mode (AppLocker / WDAC) blocks .NET method invocations
# on non-core types. Both the prompt body and the PSReadLine Enter handler
# below call [Console]::Write and [Microsoft.PowerShell.PSConsoleReadLine],
# which would surface as "Exception in custom key handler / method invocation
# is supported only on core types" on every Enter keystroke. Skip the whole
# integration in that case — there is no safe way to emit OSC 133 markers
# without console method access, and a missing semantic marker is far better
# than a per-keystroke error.
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { return }

$global:__wmux_last_exit = 0

# Stash the user's existing prompt function so we can wrap it instead of
# clobbering any customization (oh-my-posh, Starship, etc.).
if (-not (Get-Variable -Name '__wmux_prev_prompt' -Scope Global -ErrorAction SilentlyContinue)) {
    $global:__wmux_prev_prompt = (Get-Command prompt -CommandType Function -ErrorAction SilentlyContinue).ScriptBlock
}

function global:prompt {
    # Capture exit status of the PREVIOUS command before we clobber it.
    $ec = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }

    $esc = [char]27
    $bel = [char]7

    # D;<exit>  marks end of previous command.
    # A         marks start of the new prompt.
    $pre = "$esc]133;D;$ec$bel$esc]133;A$bel"

    $body = if ($global:__wmux_prev_prompt) {
        try { & $global:__wmux_prev_prompt } catch { "PS $($executionContext.SessionState.Path.CurrentLocation)> " }
    } else {
        "PS $($executionContext.SessionState.Path.CurrentLocation)> "
    }

    # B marks end of prompt / start of user input region.
    $post = "$esc]133;B$bel"

    return $pre + [string]$body + $post
}

# Command_start (C) is emitted when the user submits a line. PSReadLine's
# AcceptLine handler is the cleanest hook; wrap it so custom bindings keep
# working. The script block itself runs on every Enter, so we wrap its body
# in try/catch — registration-time try/catch wouldn't catch runtime errors
# raised inside the handler.
if (Get-Module -ListAvailable -Name PSReadLine) {
    Import-Module PSReadLine -ErrorAction SilentlyContinue
    try {
        Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {
            try {
                [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
                [Console]::Write([char]27 + ']133;C' + [char]7)
            } catch {
                # Some host (constrained sub-shell, missing console, etc.)
                # blocked the call — fall back to plain AcceptLine via the
                # default binding by re-invoking it without the OSC write.
                try { [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine() } catch { }
            }
        } -ErrorAction SilentlyContinue
    } catch {
        # Older PSReadLine versions or hosts without Set-PSReadLineKeyHandler.
    }
}
`;

// -----------------------------------------------------------------------
// Bash 4.4+ — uses PS0 (pre-execution) for C and PROMPT_COMMAND for D/A.
// PS1 suffix emits B.
// -----------------------------------------------------------------------
const BASH_INIT = `# wmux shell integration — OSC 133 semantic markers (v${INTEGRATION_VERSION})
# shellcheck shell=bash

# Allow users to opt out via env.
if [ "\${WMUX_SHELL_INTEGRATION:-1}" = "0" ]; then
  return 0 2>/dev/null || exit 0
fi

# Source the user's normal rc files first so we layer on top of their setup.
if [ -r "\$HOME/.bashrc" ] && [ -z "\${__WMUX_BASHRC_SOURCED:-}" ]; then
  export __WMUX_BASHRC_SOURCED=1
  # shellcheck disable=SC1091
  . "\$HOME/.bashrc"
fi

__wmux_last_exit=0

__wmux_preexec() {
  printf '\\033]133;C\\a'
}

__wmux_precmd() {
  __wmux_last_exit=\$?
  printf '\\033]133;D;%d\\a\\033]133;A\\a' "\$__wmux_last_exit"
}

# PS0 runs after Enter, before the command executes (bash 4.4+).
PS0='\$(__wmux_preexec)'

# PROMPT_COMMAND runs before PS1 is printed — emit D (prev command end) + A (prompt start).
case ";\${PROMPT_COMMAND:-};" in
  *";__wmux_precmd;"*) ;;
  *) PROMPT_COMMAND="__wmux_precmd\${PROMPT_COMMAND:+;\$PROMPT_COMMAND}" ;;
esac

# Append B (prompt end) to PS1 if not already present.
case "\$PS1" in
  *"133;B"*) ;;
  *) PS1="\${PS1}\\[\\033]133;B\\a\\]" ;;
esac
`;

// -----------------------------------------------------------------------
// Installer
// -----------------------------------------------------------------------

export function getShellIntegrationDir(): string {
  return path.join(getWmuxDir(), 'shell-integration');
}

export interface ShellIntegrationPaths {
  pwsh: string;
  bash: string;
}

/**
 * Write (or refresh) shell integration scripts to ~/.wmux/shell-integration/.
 * Idempotent — skips disk writes when the version file matches.
 */
export function installShellIntegration(): ShellIntegrationPaths {
  const dir = getShellIntegrationDir();
  const pwshPath = path.join(dir, 'wmux-shell-init.ps1');
  const bashPath = path.join(dir, 'wmux-shell-init.bash');
  const versionPath = path.join(dir, VERSION_FILE);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let needsWrite = true;
  try {
    if (fs.existsSync(versionPath) && fs.existsSync(pwshPath) && fs.existsSync(bashPath)) {
      const existing = fs.readFileSync(versionPath, 'utf-8').trim();
      if (existing === String(INTEGRATION_VERSION)) {
        needsWrite = false;
      }
    }
  } catch {
    // fall through to rewrite
  }

  if (needsWrite) {
    fs.writeFileSync(pwshPath, PWSH_INIT, { encoding: 'utf-8', mode: 0o600 });
    fs.writeFileSync(bashPath, BASH_INIT, { encoding: 'utf-8', mode: 0o600 });
    fs.writeFileSync(versionPath, String(INTEGRATION_VERSION), { encoding: 'utf-8', mode: 0o600 });
  }

  return { pwsh: pwshPath, bash: bashPath };
}

/**
 * Classify a shell executable path into one of the integration families.
 * Returns null when no known integration exists (e.g. cmd.exe, zsh today).
 */
export function classifyShell(shellPath: string): 'pwsh' | 'bash' | null {
  if (!shellPath) return null;
  const base = path.basename(shellPath).toLowerCase();
  if (base === 'powershell.exe' || base === 'pwsh.exe' || base === 'pwsh') return 'pwsh';
  if (base === 'bash.exe' || base === 'bash') return 'bash';
  return null;
}

export interface SpawnInjection {
  args: string[];
  env: Record<string, string>;
}

/**
 * Produce the extra spawn args + env vars needed to activate shell
 * integration for a known shell. Returns null for shells that have no
 * integration (cmd.exe, etc.) — caller should spawn the shell normally.
 */
export function buildSpawnInjection(shellPath: string): SpawnInjection | null {
  const kind = classifyShell(shellPath);
  if (!kind) return null;

  const paths = installShellIntegration();

  if (kind === 'pwsh') {
    // -NoExit keeps the interactive session alive after the init script runs.
    // Dot-source the script so its function definitions persist in the shell.
    return {
      args: ['-NoLogo', '-NoExit', '-Command', `. '${paths.pwsh.replace(/'/g, "''")}'`],
      env: { WMUX_SHELL_INTEGRATION: '1' },
    };
  }

  // bash: --rcfile swaps the normal .bashrc. Our init script sources the user's
  // real .bashrc internally so we're additive rather than destructive.
  return {
    args: ['--rcfile', paths.bash, '-i'],
    env: { WMUX_SHELL_INTEGRATION: '1' },
  };
}
