import * as fs from 'node:fs';
import * as path from 'node:path';
import { getWmuxDir } from './config';
import { isMac } from '../shared/platform';

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
 *   - zsh 5.x              (macOS 기본 셸 — ZDOTDIR 가로채기 방식)
 *
 * Explicitly NOT covered:
 *   - cmd.exe              (no prompt hook, OSC 133 is a no-op there)
 *   - fish                 (v3 roadmap)
 */

// v6: zsh stub에 OSC 7(cwd) 방출 추가 — mac 기본 zsh가 cd를 보고하지 않아
// 사이드바 브랜치/git 컨텍스트가 생성 시점 cwd에 고정되던 문제 수정
// (owner-reported 2026-07-19).
// v7: 번호만 재승격 — 릴리즈 데몬이 OSC 7 없는 스크립트를 ".version=6"으로
// 이미 설치해 둔 기기에서 v6 게이트가 "최신"으로 오판, OSC 7 스텁이 영영
// 설치되지 않던 문제(dogfood 실측 2026-07-20). 내용 변경 없음.
// v8: emit OSC 7 (cwd) from the pwsh and bash integrations too (issue #540).
// The daemon's OSC 7-sticky permanently disables prompt scraping on the first
// OSC 7 it sees, on the assumption that "the integration hook re-emits OSC 7
// on every prompt" — which v6 made true only for zsh. On pwsh/bash a single
// stray OSC 7 from any child program (agent TUI, nested shell) killed the only
// cwd source, freezing the pane's tracked cwd at its spawn value (usually
// home) — so splits landed in home, regressing #515.
const INTEGRATION_VERSION = 8;
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

    # D;<exit>  marks end of previous command.
    # A         marks start of the new prompt.
    $pre = "$esc]133;D;$ec$bel$esc]133;A$bel"

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
// zsh 5.x (macOS 기본 셸) — ZDOTDIR 가로채기 방식.
//
// zsh는 bash의 --rcfile 같은 옵션이 없다. 대신 시작 시 $ZDOTDIR(미설정 시
// $HOME)의 .zshenv → .zprofile → .zshrc → .zlogin을 로드한다. 그래서 wmux는
// ZDOTDIR을 자기 디렉토리로 바꿔 띄우고, 그 안의 stub들이 사용자의 원래 zsh
// 파일을 먼저 source한 뒤(WMUX_USER_ZDOTDIR로 원래 위치 전달) .zshrc에서만
// OSC 133 hook을 추가한다. VS Code / iTerm2와 동일한 표준 기법.
//
// 핵심 안전장치: 사용자 설정을 절대 잃지 않도록 4개 파일 모두 원래 것을
// source하고, .zshrc 끝에서 ZDOTDIR을 사용자 값으로 복원해 이후 셸 동작이
// 평소와 동일하게 유지되게 한다.
// -----------------------------------------------------------------------

// 공통: 원래 ZDOTDIR(없으면 HOME) 위임. <hook>은 파일별 OSC 133 추가분.
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

# 사용자의 실제 .zshrc를 먼저 로드해 alias/PATH/테마(oh-my-zsh 등)를 보존한다.
[ -r "$__wmux_uzd/.zshrc" ] && source "$__wmux_uzd/.zshrc"

# ZDOTDIR을 사용자 값으로 되돌린다. 이후 서브셸/재로드가 평소처럼 동작하도록.
if [ "$__wmux_uzd" = "$HOME" ]; then
  unset ZDOTDIR
else
  export ZDOTDIR="$__wmux_uzd"
fi

# 옵트아웃: WMUX_SHELL_INTEGRATION=0 이면 OSC 133 markers를 달지 않는다.
if [ "\${WMUX_SHELL_INTEGRATION:-1}" = "0" ]; then
  return 0 2>/dev/null
fi

# preexec: 명령 실행 직전 → C (command start)
__wmux_preexec() { printf '\\033]133;C\\a'; }
# precmd: 프롬프트 출력 직전 → D;<exit> (이전 명령 종료) + A (프롬프트 시작)
__wmux_precmd() { local __ec=$?; printf '\\033]133;D;%d\\a\\033]133;A\\a' "$__ec"; }

# OSC 7: cwd 보고 — wmux 사이드바가 브랜치/포트/PR을 pane의 실제 디렉토리로
# 추적하려면 cd를 감지해야 한다. mac 기본 zsh는 OSC 7을 안 쏘고 daemon의
# 프롬프트 스크레이프도 zsh 프롬프트(host%)를 못 잡아, 이 hook 없이는 생성
# 시점 cwd에 고정된다. chpwd로 cd 즉시(뒤에 장기 실행 명령이 붙어도) 보고 +
# precmd로 최초/매 프롬프트 보고. parseOsc7Cwd와 맞춰 host 뒤 슬래시 없이
# \$PWD(절대경로, / 로 시작)를 붙여 file://host/abs/path 형태로 낸다.
__wmux_osc7() { printf '\\033]7;file://%s%s\\a' "\${HOST-localhost}" "$PWD"; }

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

# B (프롬프트 끝 / 사용자 입력 시작)을 PROMPT 끝에 한 번만 추가.
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
  /** zsh ZDOTDIR로 쓸 디렉토리 (.zshenv/.zprofile/.zlogin/.zshrc 포함). */
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
    // zsh: ZDOTDIR 디렉토리에 4개 stub 작성 (사용자 설정 위임 + .zshrc만 OSC 133).
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
 * Returns null when no known integration exists (e.g. cmd.exe, zsh today).
 */
export function classifyShell(shellPath: string): 'pwsh' | 'bash' | 'zsh' | null {
  if (!shellPath) return null;
  // 로그인 셸은 argv[0]가 '-zsh'처럼 앞에 '-'가 붙는다.
  const base = path.basename(shellPath).toLowerCase().replace(/^-/, '');
  if (base === 'powershell.exe' || base === 'pwsh.exe' || base === 'pwsh') return 'pwsh';
  if (base === 'bash.exe' || base === 'bash') return 'bash';
  if (base === 'zsh') return 'zsh';
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

  if (kind === 'zsh') {
    // zsh: ZDOTDIR을 wmux zsh 디렉토리로 바꿔 OSC 133 stub들이 로드되게 한다.
    // 원래 ZDOTDIR(사용자 .zshrc 위치)은 DaemonSessionManager가 spawn 직전에
    // WMUX_USER_ZDOTDIR로 보존하므로, stub들이 사용자 설정을 먼저 source한다.
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
