import * as fs from 'node:fs';
import * as path from 'node:path';
import { getWmuxDir } from './config';
import { isMac, isWindows } from '../shared/platform';

/**
 * Shell integration installer: materializes OSC 133 init scripts into
 * ~/.wmux/shell-integration/ so that spawned PTYs can source them
 * regardless of whether wmux runs from a packaged Electron asar bundle or
 * a dev tree. Scripts are versioned; if the on-disk copy is stale (or
 * missing) we overwrite it.
 *
 * Coverage:
 *   - PowerShell 5.1 / 7+  (powershell.exe, pwsh.exe)  — OSC 133 + OSC 7 (cwd)
 *   - Bash 4.4+            (Git Bash, WSL)              — OSC 133 + OSC 7 (cwd)
 *   - zsh 5.x              (macOS default shell, ZDOTDIR intercept) — OSC 133 + OSC 7
 *   - cmd.exe              (Windows only)              — OSC 7 (cwd) via PROMPT
 *                                                        (no scriptable hook →
 *                                                         no OSC 133)
 *
 * Explicitly NOT covered:
 *   - fish                 (v3 roadmap)
 *
 * The OSC 7 (cwd) emission here mirrors the standalone hooks in
 * src/main/pty/shell-hooks/ (used by the main-process PTYManager spawn path);
 * the daemon spawn path uses THIS module. Keep the two in sync — both feed the
 * same parseOsc7Cwd, and once either emits OSC 7 the bridge marks the pane
 * OSC-7-sticky and stops scraping prompt text for that session.
 */

// v6: add OSC 7 (cwd) emission to zsh stub — default mac zsh does not report cd,
// so sidebar branch/git context stayed pinned to spawn-time cwd
// (owner-reported 2026-07-19).
// v7: version bump only — release daemon had installed OSC-7-less scripts as ".version=6"
// on some devices, so v6 gate misjudged "latest" and OSC 7 stub never installed
// (dogfood 2026-07-20). No content change.
// v8: emit OSC 7 (cwd) from the pwsh and bash integrations too (issue #540).
// The daemon's OSC 7-sticky permanently disables prompt scraping on the first
// OSC 7 it sees, on the assumption that "the integration hook re-emits OSC 7
// on every prompt" — which v6 made true only for zsh. On pwsh/bash a single
// stray OSC 7 from any child program (agent TUI, nested shell) killed the only
// cwd source, freezing the pane's tracked cwd at its spawn value (usually
// home) — so splits landed in home, regressing #515.
// v9: percent-encode the zsh OSC 7 payload — parity with the v8 pwsh/bash
// encoders (#541 review follow-up). The v6 zsh hook emitted raw $PWD, but the
// daemon's parseOsc7Cwd unconditionally decodeURIComponent()s the payload, so
// a directory whose real name contains a literal percent sequence
// ("build%20cache") was silently corrupted, and a raw ESC/BEL byte in a
// directory name could terminate the OSC 7 early and inject terminal escapes.
const INTEGRATION_VERSION = 9;
const VERSION_FILE = '.version';

// -----------------------------------------------------------------------
// PowerShell (pwsh 7+ and Windows PowerShell 5.1) — uses PSReadLine hook
// for the command_start marker and prompt function for A/B/D.
// -----------------------------------------------------------------------
export const PWSH_INIT = `# wmux shell integration — OSC 133 semantic markers (v${INTEGRATION_VERSION})
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
    # Capture $? and $LASTEXITCODE as the VERY FIRST statements. Any
    # comparison, assignment, or cmdlet call inside this function resets
    # $? to true — so a later 'elseif ($?)' check would always take the
    # success branch and report D;0 even after a failed command. This
    # same trap bites VS Code / Windows Terminal integrations; the fix
    # is to snapshot both variables before doing anything else.
    $__wmux_ok = $?
    $__wmux_le = $LASTEXITCODE
    $ec = if ($null -ne $__wmux_le) { $__wmux_le } elseif ($__wmux_ok) { 0 } else { 1 }

    $esc = [char]27
    $bel = [char]7

    # OSC 7 (cwd): report the working directory over the authoritative escape
    # channel so wmux tracks 'cd' without scraping prompt text. Only the
    # FileSystem provider maps to a real path (skip Registry:/Cert: etc.);
    # ProviderPath resolves a PSDrive to its backing path. Forward slashes and a
    # single leading slash after the host match parseOsc7Cwd's shape (drive:
    # /C:/x, UNC: ///server/x). Mirrors src/main/pty/shell-hooks/pwsh.ps1.
    $osc7 = ''
    try {
        $loc = $executionContext.SessionState.Path.CurrentLocation
        if ($loc.Provider.Name -eq 'FileSystem') {
            $osc7 = "$esc]7;file://$env:COMPUTERNAME/$($loc.ProviderPath -replace '\\\\','/')$bel"
        }
    } catch { }

    # D;<exit>  marks end of previous command.
    # A         marks start of the new prompt.
    $pre = "$esc]133;D;$ec$bel$esc]133;A$bel$osc7"

    # OSC 7: cwd report (issue #540). wmux treats OSC 7 as the authoritative
    # cwd source and turns prompt scraping off for good the first time it sees
    # one — so this hook MUST re-emit on every prompt (parity with the zsh
    # integration), or a single stray OSC 7 from a child program would freeze
    # the pane's tracked cwd. FileSystem provider only: a registry/cert
    # location has no directory to report.
    #
    # Each path segment is percent-encoded (CodeRabbit review on #541): the
    # daemon's parseOsc7Cwd unconditionally decodeURIComponent()s the payload,
    # so a raw path containing a literal '%' (e.g. "build%20cache") would
    # otherwise be silently corrupted by the decode. Splitting on '\' first and
    # encoding each segment keeps '/' as the literal path separator
    # parseOsc7Cwd expects while %-escaping everything else — colons, spaces,
    # unicode, and literal '%' all round-trip correctly through decode.
    $loc = $executionContext.SessionState.Path.CurrentLocation
    if ($loc.Provider.Name -eq 'FileSystem') {
        $osc7Path = ($loc.ProviderPath -split '\\\\' | ForEach-Object { [Uri]::EscapeDataString($_) }) -join '/'
        $pre += "$esc]7;file://$env:COMPUTERNAME/$osc7Path$bel"
    }

    $body = if ($global:__wmux_prev_prompt) {
        try { & $global:__wmux_prev_prompt } catch { "PS $($executionContext.SessionState.Path.CurrentLocation)> " }
    } else {
        "PS $($executionContext.SessionState.Path.CurrentLocation)> "
    }

    # B marks end of prompt / start of user input region.
    $post = "$esc]133;B$bel"

    # Restore $LASTEXITCODE so downstream user tooling sees the value it
    # would have seen without shell integration. The prompt body above
    # may have invoked cmdlets that touched it.
    $global:LASTEXITCODE = $__wmux_le

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
export const BASH_INIT = `# wmux shell integration — OSC 133 semantic markers (v${INTEGRATION_VERSION})
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

# Percent-encode a path for OSC 7 (CodeRabbit review on #541): the daemon's
# parseOsc7Cwd unconditionally decodeURIComponent()s the payload, so a raw '%'
# in a directory name (e.g. "build%20cache") would otherwise be silently
# corrupted by the decode, and a raw ESC/BEL byte in a directory name would
# terminate the OSC 7 sequence early and let its remaining bytes inject
# arbitrary terminal escape sequences. One byte-wise walk over the whole path:
# '/' passes through as the literal separator parseOsc7Cwd expects, RFC 3986
# unreserved characters pass as-is, everything else becomes %XX. LC_ALL=C makes
# bash index/slice the string byte-wise (not by UTF-8 codepoint), so multi-byte
# characters are encoded byte-by-byte — the exact %-per-byte scheme
# decodeURIComponent expects. Walking the whole string (instead of splitting on
# '/' and re-joining) keeps trailing slashes (drive root "/c:/") and even
# newline bytes in hostile directory names intact.
__wmux_osc7_encode() {
  local LC_ALL=C LC_CTYPE=C
  local s="\$1" out= c i hex
  for (( i=0; i<\${#s}; i++ )); do
    c="\${s:i:1}"
    case "\$c" in
      [a-zA-Z0-9./~_-]) out+="\$c" ;;
      *) printf -v hex '%02X' "'\$c"; out+="%\$hex" ;;
    esac
  done
  printf '%s' "\$out"
}

# OSC 7: cwd report (issue #540) — parity with the zsh integration, because
# wmux disables prompt scraping permanently after the first OSC 7 and relies
# on the hook re-emitting it on every prompt. Git Bash (MSYSTEM set) rewrites
# /c/Users/... to /c:/Users/... so wmux's parseOsc7Cwd recovers the real
# Windows path; WSL/Linux/macOS emit \$PWD as-is (percent-encoded either way,
# see __wmux_osc7_encode).
__wmux_osc7() {
  local p="\$PWD"
  if [ -n "\${MSYSTEM:-}" ]; then
    case "\$p" in
      /[A-Za-z]/*) p="/\${p:1:1}:\${p:2}" ;;
      /[A-Za-z])   p="/\${p:1:1}:/" ;;
    esac
  fi
  printf '\\033]7;file://%s%s\\a' "\${HOSTNAME-localhost}" "\$(__wmux_osc7_encode "\$p")"
}

__wmux_precmd() {
  __wmux_last_exit=\$?
  printf '\\033]133;D;%d\\a\\033]133;A\\a' "\$__wmux_last_exit"
  __wmux_osc7
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
// zsh 5.x (macOS default shell) — ZDOTDIR interception approach.
//
// zsh has no bash-style --rcfile option. Instead it loads .zshenv → .zprofile →
// .zshrc → .zlogin from $ZDOTDIR (or $HOME if unset) at startup. So wmux
// launches with ZDOTDIR pointing at its directory; stubs source the user's
// original zsh files first (WMUX_USER_ZDOTDIR carries the original location),
// then add OSC 133 hooks only in .zshrc. Same standard technique as VS Code / iTerm2.
//
// Key safety: all four files source the user's originals so settings are never lost;
// .zshrc restores ZDOTDIR to the user's value at the end so subsequent shell behavior
// stays normal.
// -----------------------------------------------------------------------

// Common: delegate to original ZDOTDIR (or HOME). <hook> is per-file OSC 133 addition.
const ZSH_ENV = `# wmux shell integration — zsh .zshenv stub (v${INTEGRATION_VERSION})
__wmux_uzd="\${WMUX_USER_ZDOTDIR:-$HOME}"
[ -r "$__wmux_uzd/.zshenv" ] && source "$__wmux_uzd/.zshenv"
`;

const ZSH_PROFILE = `# wmux shell integration — zsh .zprofile stub (v${INTEGRATION_VERSION})
__wmux_uzd="\${WMUX_USER_ZDOTDIR:-$HOME}"
[ -r "$__wmux_uzd/.zprofile" ] && source "$__wmux_uzd/.zprofile"
`;

const ZSH_LOGIN = `# wmux shell integration — zsh .zlogin stub (v${INTEGRATION_VERSION})
__wmux_uzd="\${WMUX_USER_ZDOTDIR:-$HOME}"
[ -r "$__wmux_uzd/.zlogin" ] && source "$__wmux_uzd/.zlogin"
`;

export const ZSH_RC = `# wmux shell integration — OSC 133 semantic markers (zsh, v${INTEGRATION_VERSION})
# Emits prompt/command boundaries so wmux's daemon can index command output.

__wmux_uzd="\${WMUX_USER_ZDOTDIR:-$HOME}"

# Load the user's real .zshrc first to preserve alias/PATH/theme (oh-my-zsh, etc.).
[ -r "$__wmux_uzd/.zshrc" ] && source "$__wmux_uzd/.zshrc"

# Restore ZDOTDIR to the user's value so subshells/reloads behave normally.
if [ "$__wmux_uzd" = "$HOME" ]; then
  unset ZDOTDIR
else
  export ZDOTDIR="$__wmux_uzd"
fi

# Opt-out: WMUX_SHELL_INTEGRATION=0 skips OSC 133 markers.
if [ "\${WMUX_SHELL_INTEGRATION:-1}" = "0" ]; then
  return 0 2>/dev/null
fi

# preexec: just before command runs → C (command start)
__wmux_preexec() { printf '\\033]133;C\\a'; }
# precmd: just before prompt → D;<exit> (previous command end) + A (prompt start)
__wmux_precmd() { local __ec=$?; printf '\\033]133;D;%d\\a\\033]133;A\\a' "$__ec"; }

# OSC 7: cwd reporting — wmux sidebar tracks branch/port/PR to the pane's actual directory,
# so cd must be detected. Default mac zsh does not emit OSC 7 and daemon prompt scraping
# cannot match zsh prompts (host%), so without this hook cwd stays at spawn time.
# chpwd reports immediately on cd (even before a long-running command) +
# precmd on first/each prompt. Matches parseOsc7Cwd: no slash after host,
# append $PWD (absolute, leading /) as file://host/abs/path.
#
# v9: percent-encode the payload (parity with the pwsh/bash v8 encoders —
# #541 review follow-up). The daemon's parseOsc7Cwd unconditionally
# decodeURIComponent()s the payload, so a raw '%' in a directory name
# ("build%20cache") was silently corrupted by the decode, and a raw ESC/BEL
# byte in a directory name could terminate the OSC 7 early and inject
# terminal escape sequences. One byte-wise walk over the whole path: '/'
# passes through as the separator, RFC 3986 unreserved bytes pass as-is,
# everything else becomes %XX. LC_ALL=C makes zsh index the string by byte
# (not by UTF-8 codepoint), so multi-byte characters are encoded per byte —
# the exact scheme decodeURIComponent expects. \`emulate -L zsh\` shields the
# function from user rc options (KSH_ARRAYS would shift the 1-based string
# subscripts this loop depends on).
__wmux_osc7_encode() {
  emulate -L zsh
  local LC_ALL=C LC_CTYPE=C
  local s="$1" out='' c hex
  local -i i
  for (( i = 1; i <= \${#s}; i++ )); do
    c="\${s[i]}"
    case "$c" in
      [a-zA-Z0-9./~_-]) out+="$c" ;;
      *) hex=\$(( [##16] #c )); [ \${#hex} -eq 1 ] && hex="0$hex"; out+="%$hex" ;;
    esac
  done
  printf '%s' "$out"
}

__wmux_osc7() { printf '\\033]7;file://%s%s\\a' "\${HOST-localhost}" "\$(__wmux_osc7_encode "$PWD")"; }

autoload -Uz add-zsh-hook 2>/dev/null
if (( \${+functions[add-zsh-hook]} )); then
  add-zsh-hook preexec __wmux_preexec
  add-zsh-hook precmd __wmux_precmd
  add-zsh-hook chpwd __wmux_osc7
  add-zsh-hook precmd __wmux_osc7
else
  typeset -ga preexec_functions precmd_functions chpwd_functions
  preexec_functions+=(__wmux_preexec)
  precmd_functions+=(__wmux_precmd)
  chpwd_functions+=(__wmux_osc7)
  precmd_functions+=(__wmux_osc7)
fi

# B (prompt end / user input start) appended once at end of PROMPT.
# Wrap the raw OSC in zsh's %{...%} zero-width guard. Without it zle counts the
# escape bytes as printable prompt width, and zrefresh/resetvideo overruns the
# line buffer during resize sweeps → SIGBUS crash (RCA 2026-07-05).
if [[ "$PROMPT" != *"133;B"* ]]; then
  PROMPT="\${PROMPT}%{"$'\\033]133;B\\a'"%}"
fi
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
  /** zsh ZDOTDIR directory (contains .zshenv/.zprofile/.zlogin/.zshrc). */
  zshDir: string;
}

/**
 * Write (or refresh) shell integration scripts to ~/.wmux/shell-integration/.
 * Idempotent — skips disk writes when the version file matches.
 */
export function installShellIntegration(): ShellIntegrationPaths {
  const dir = getShellIntegrationDir();
  const pwshPath = path.join(dir, 'wmux-shell-init.ps1');
  const bashPath = path.join(dir, 'wmux-shell-init.bash');
  const zshDir = path.join(dir, 'zsh');
  const versionPath = path.join(dir, VERSION_FILE);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let needsWrite = true;
  try {
    if (
      fs.existsSync(versionPath) &&
      fs.existsSync(pwshPath) &&
      fs.existsSync(bashPath) &&
      fs.existsSync(path.join(zshDir, '.zshrc'))
    ) {
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
    // zsh: write four stubs under ZDOTDIR (delegate user config + OSC 133 only in .zshrc).
    if (!fs.existsSync(zshDir)) {
      fs.mkdirSync(zshDir, { recursive: true });
    }
    fs.writeFileSync(path.join(zshDir, '.zshenv'), ZSH_ENV, { encoding: 'utf-8', mode: 0o600 });
    fs.writeFileSync(path.join(zshDir, '.zprofile'), ZSH_PROFILE, { encoding: 'utf-8', mode: 0o600 });
    fs.writeFileSync(path.join(zshDir, '.zlogin'), ZSH_LOGIN, { encoding: 'utf-8', mode: 0o600 });
    fs.writeFileSync(path.join(zshDir, '.zshrc'), ZSH_RC, { encoding: 'utf-8', mode: 0o600 });
    fs.writeFileSync(versionPath, String(INTEGRATION_VERSION), { encoding: 'utf-8', mode: 0o600 });
  }

  return { pwsh: pwshPath, bash: bashPath, zshDir };
}

/**
 * Classify a shell executable path into one of the integration families.
 * Returns null when no known integration exists (e.g. fish).
 */
export function classifyShell(shellPath: string): 'pwsh' | 'bash' | 'zsh' | 'cmd' | null {
  if (!shellPath) return null;
  // Login shells have argv[0] prefixed with '-' (e.g. '-zsh').
  const base = path.basename(shellPath).toLowerCase().replace(/^-/, '');
  if (base === 'powershell.exe' || base === 'pwsh.exe' || base === 'pwsh') return 'pwsh';
  if (base === 'bash.exe' || base === 'bash') return 'bash';
  if (base === 'zsh') return 'zsh';
  if (base === 'cmd.exe' || base === 'cmd') return 'cmd';
  return null;
}

export interface SpawnInjection {
  args: string[];
  env: Record<string, string>;
}

/**
 * Convert a Windows path to its WSL mount path so a script on the Windows
 * filesystem can be sourced from inside a distro: `C:\Users\me\x` →
 * `/mnt/c/Users/me/x`.
 *
 * Assumes WSL's default automount root (`/mnt/`). A distro with a custom
 * `[automount] root` in `/etc/wsl.conf` won't match — in that case `bash`
 * can't open the rcfile and simply starts without our hook, so the pane falls
 * back to prompt scraping (no hard failure). Pure/deterministic so it's unit
 * testable without a WSL install.
 */
export function toWslMountPath(winPath: string): string {
  const m = /^([A-Za-z]):(.*)$/.exec(winPath);
  if (!m) return winPath.replace(/\\/g, '/');
  const drive = m[1].toLowerCase();
  const rest = m[2].replace(/\\/g, '/');
  return `/mnt/${drive}${rest.startsWith('/') ? '' : '/'}${rest}`;
}

/**
 * Build the spawn injection for a `wsl.exe` launcher whose distro login shell
 * is bash. Produces `-- bash --rcfile <mnt-path> -i`, which — composed after
 * the daemon's `preparePtyLocation` `--cd` prefix — spawns
 * `wsl.exe [--cd <cwd>] -- bash --rcfile /mnt/c/…/wmux-shell-init.bash -i`.
 * The rcfile sources the user's own ~/.bashrc internally, so it is additive.
 *
 * IMPORTANT: only use this when the distro's login shell really is bash. It
 * forces bash, so a zsh/fish user would otherwise be dropped into bash — the
 * daemon probes the login shell before calling this and skips it (falling back
 * to prompt scraping) for non-bash shells.
 */
export function buildWslBashInjection(): SpawnInjection {
  const paths = installShellIntegration();
  const rcfile = toWslMountPath(paths.bash);
  return {
    args: ['--', 'bash', '--rcfile', rcfile, '-i'],
    env: { WMUX_SHELL_INTEGRATION: '1' },
  };
}

/**
 * Produce the extra spawn args + env vars needed to activate shell
 * integration for a known shell. Returns null for shells that have no
 * integration (fish, etc.) — caller should spawn the shell normally.
 */
export function buildSpawnInjection(shellPath: string): SpawnInjection | null {
  const kind = classifyShell(shellPath);
  if (!kind) return null;

  if (kind === 'cmd') {
    // cmd.exe has no scriptable prompt hook, so OSC 133 semantic markers are
    // impossible — but OSC 7 (cwd) can ride the PROMPT env var. $P is the
    // current path (native backslashes; parseOsc7Cwd normalizes), $E is ESC,
    // $E\ the ST terminator, $G the '>'. The host segment is a literal — '$C'
    // is a CMD PROMPT metachar that expands to '(', so '$COMPUTERNAME' would
    // emit a stray "(OMPUTERNAME" token. Windows-only; cmd.exe spawns nowhere
    // else. No installed script needed. Mirrors PTYManager.buildHookInjection.
    if (!isWindows) return null;
    return { args: [], env: { PROMPT: '$E]7;file://localhost/$P$E\\$P$G' } };
  }

  const paths = installShellIntegration();

  if (kind === 'pwsh') {
    // -NoExit keeps the interactive session alive after the init script runs.
    // Dot-source the script so its function definitions persist in the shell.
    return {
      args: ['-NoLogo', '-NoExit', '-Command', `. '${paths.pwsh.replace(/'/g, "''")}'`],
      env: { WMUX_SHELL_INTEGRATION: '1' },
    };
  }

  if (kind === 'zsh') {
    // zsh: set ZDOTDIR to wmux zsh dir so OSC 133 stubs load.
    // Original ZDOTDIR (user .zshrc location) is preserved as WMUX_USER_ZDOTDIR by
    // DaemonSessionManager before spawn, so stubs source user config first.
    //
    // `-l` on macOS (#519). The standard macOS PATH is assembled by
    // /etc/zprofile, which runs /usr/libexec/path_helper — and zprofile is a
    // LOGIN file. Interactive-only meant it never ran, so a pane inherited
    // whatever PATH the daemon had (launchd's minimal one for a GUI launch)
    // and lost /opt/homebrew/bin, /usr/sbin, /sbin, /Library/Apple/usr/bin and
    // every /etc/paths.d entry. .zshrc still ran, which is why the shell looked
    // fine until an unqualified Homebrew command failed.
    //
    // The .zprofile/.zlogin stubs this enables were already written and already
    // delegate to the user's real files — they were simply never read.
    //
    // macOS only: Terminal.app, iTerm2 and VS Code all spawn login shells there,
    // so this matches the platform convention. Linux terminals default to
    // non-login and adding -l would newly source /etc/profile + ~/.zprofile for
    // existing users — a behavior change with no bug behind it.
    return {
      args: isMac ? ['-l', '-i'] : ['-i'],
      env: { WMUX_SHELL_INTEGRATION: '1', ZDOTDIR: paths.zshDir },
    };
  }

  // bash: --rcfile swaps the normal .bashrc. Our init script sources the user's
  // real .bashrc internally so we're additive rather than destructive.
  return {
    args: ['--rcfile', paths.bash, '-i'],
    env: { WMUX_SHELL_INTEGRATION: '1' },
  };
}
