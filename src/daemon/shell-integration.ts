import * as fs from 'node:fs';
import * as path from 'node:path';
import { getWmuxDir } from './config';
import { isMac } from '../shared/platform';
import { windowsPowerShellPolicyArgs } from '../shared/pwshExecutionPolicy';

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
// v9: percent-encode the zsh OSC 7 payload — parity with the v8 pwsh/bash
// encoders (#541 review follow-up). The v6 zsh hook emitted raw $PWD, but the
// daemon's parseOsc7Cwd unconditionally decodeURIComponent()s the payload, so
// a directory whose real name contains a literal percent sequence
// ("build%20cache") was silently corrupted, and a raw ESC/BEL byte in a
// directory name could terminate the OSC 7 early and inject terminal escapes.
// v10: hand the $? snapshot to the wrapped prompt (issue #1267). The wrapper
// snapshots $? and $LASTEXITCODE as its first two statements, but never gave
// that snapshot to the prompt it wraps — and every statement in between resets
// $? to true. So oh-my-posh, Starship, and anything else that reads $? to
// colour an exit-code segment saw "success" after every failed command, while
// the same config in Windows Terminal was correct.
// v11: decide the exit code from whether $LASTEXITCODE MOVED (issue #1270). It
// is set only by native commands and never cleared, so preferring it whenever
// it was non-null meant that from a session's first native command onward every
// failing cmdlet reported D;0 — the value agent.lifecycle.exitCode is built
// from. Preferring $? instead trades the bug for its mirror image, marking a
// successful cmdlet failed with the previous native command's code. Movement
// since the last prompt is what separates "this number describes the command
// that just ran" from "this number is left over".
// v12: a `codex` shell function in the bash and zsh integrations. Codex CLI
// 0.157+ starts one shared per-account background server the first time a
// TUI runs, and that server outlives the pane that started it and parents
// the shell commands and MCP servers of every later Codex thread on the
// account. Typed in a pane, it inherited that pane's WMUX_* keys, so other
// panes' Codex commands acted as the first pane. See CODEX_SEED_GUARD.
// v13: the pwsh integration reports the cwd in the middle of a command line
// too (issue #1941). It reported it only from the prompt, so on
// 'cd X; claude' the pane's tracked cwd stayed at the folder of the last
// prompt for as long as the program ran, and a daemon restart in that window
// recovered the pane there. See $global:__wmux_lookup in PWSH_INIT.
const INTEGRATION_VERSION = 13;

// -----------------------------------------------------------------------
// Codex shared-server seed guard (v12) — shared by the bash and zsh scripts.
//
// Measured against codex-cli 0.157.1 with a fresh CODEX_HOME and no server
// running:
//   - `codex`, `codex resume --last`, `codex agents` → start a managed server
//     (ppid 1) that carries every WMUX_* key of the shell that typed it.
//   - `--no-daemon` (before or after `resume`) → no server, no control socket.
//   - `-c features.daemon_auto_start=false` → interactive forms and `exec`
//     run in-process instead, with no error; `agents` still starts a server,
//     and an explicit `app-server daemon start` still works.
//   - `exec`/`e`/`review` → run in-process; no server started, and none
//     connected to when one was already running.
//
// Classifying the command line is best effort, so no classification is
// trusted to keep the pane identity on its own:
//   - every wrapped call gets `-c features.daemon_auto_start=false` when the
//     installed codex knows that feature — a misread line still cannot start
//     the server from this shell;
//   - any word naming a server (`app-server`, `exec-server`, `remote-control`,
//     `daemon`), anywhere on the line, runs the call with every WMUX_* key
//     removed. A false positive only drops the pane identity for that run;
//   - interactive forms (no subcommand, a prompt, `resume`, `fork`, any
//     `-i/--image`, which only the interactive CLI takes) also get
//     `--no-daemon` and keep the pane env — the thread runs in this process,
//     so its commands act as this pane and nothing outlives it. Without the
//     feature guard or `--no-daemon` they run with WMUX_* removed;
//   - `exec`/`e`/`review` keep the pane env: the hooks bridge needs
//     WMUX_PTY_ID to attribute their events to this pane;
//   - an option this function does not know, before the first word, means the
//     subcommand cannot be told apart from an option value: identity is kept
//     only when the feature guard is available (plus `--no-daemon`), otherwise
//     WMUX_* is removed;
//   - every other subcommand (`agents`, `queue`, `app`, `login`, …) runs with
//     WMUX_* removed.
// It steps aside entirely when the command already chooses a server
// (`--remote`, `--no-daemon` — wmux's own Codex launches pass `--remote`),
// when WMUX_CODEX_WRAP=0, or when no codex executable is on PATH.
//
// What the installed codex supports is probed once per binary (keyed by its
// path, inode and mtime) with `--help` and `features list`, both run with
// WMUX_* removed. The binary is always called by absolute path: zsh
// alias-expands the word after `command`, and the user's rc is sourced before
// this function is defined. On WSL the pane PATH starts with wmux's own codex
// shim, which finds the real codex by skipping WMUX_WSL_BIN; calls that remove
// WMUX_* therefore go to the real codex directly (through the shim they would
// find the shim again and re-exec forever).
//
// Not covered (the codex CLI is reached without this function): scripts and
// `bash -c`/`zsh -c` lines, `env codex`, `exec codex`, a full path to the
// binary, a user alias for codex that expands to anything but `codex …`
// (aliases win over functions), a shell started inside the pane (nested
// zsh/bash, tmux, screen — they read the user's rc, not this one), a
// user-defined `codex` function (left alone on purpose), Git Bash, shells with
// the integration turned off, fish/pwsh, and shells opened before v12 was
// installed.
// -----------------------------------------------------------------------
function codexSeedGuardHelpers(unsetAll: string): string {
  return `__wmux_codex_classify() {
  local __wmux_a __wmux_skip=0 __wmux_sub='' __wmux_end=0 __wmux_pass=0 __wmux_srv=0 __wmux_img=0 __wmux_unk=0
  __wmux_codex_kind=''
  for __wmux_a in "$@"; do
    case "$__wmux_a" in
      app-server|exec-server|remote-control|daemon) __wmux_srv=1 ;;
    esac
    [ "$__wmux_end" = 1 ] && continue
    if [ "$__wmux_skip" = 1 ]; then __wmux_skip=0; continue; fi
    case "$__wmux_a" in
      --) __wmux_end=1; continue ;;
      --remote|--remote=*|--no-daemon) __wmux_pass=1; continue ;;
    esac
    { [ -n "$__wmux_sub" ] || [ "$__wmux_img" = 1 ]; } && continue
    case "$__wmux_a" in
      -c|--config|-m|--model|-p|--profile|-s|--sandbox|-a|--ask-for-approval|-C|--cd|--enable|--disable|--add-dir|--local-provider|--remote-auth-token-env) __wmux_skip=1 ;;
      -i|--image|-i?*|--image=*) __wmux_img=1 ;;
      --oss|--strict-config|--approve-for-me|--dangerously-bypass-approvals-and-sandbox|--dangerously-bypass-hook-trust|--worktree|--search|--no-alt-screen|-h|--help|-V|--version) ;;
      -[cmpsaC]?*) ;;
      --*=*)
        case "\${__wmux_a%%=*}" in
          --config|--model|--profile|--sandbox|--ask-for-approval|--cd|--enable|--disable|--add-dir|--local-provider|--remote-auth-token-env) ;;
          *) __wmux_unk=1 ;;
        esac ;;
      -*) __wmux_unk=1 ;;
      *) __wmux_sub="$__wmux_a" ;;
    esac
  done
  if [ "$__wmux_srv" = 1 ]; then __wmux_codex_kind=scrub
  elif [ "$__wmux_pass" = 1 ]; then __wmux_codex_kind=pass
  elif [ "$__wmux_img" = 1 ]; then __wmux_codex_kind=tui
  elif [ "$__wmux_unk" = 1 ]; then __wmux_codex_kind=unknown
  else
    case "$__wmux_sub" in
      ''|resume|fork) __wmux_codex_kind=tui ;;
      exec|e|review) __wmux_codex_kind=env ;;
      agents|login|logout|mcp|plugin|app|completion|update|doctor|sandbox|debug|apply|a|queue|archive|delete|migrate-rollouts|unarchive|cloud|features|help) __wmux_codex_kind=scrub ;;
      *) __wmux_codex_kind=tui ;;
    esac
  fi
}

# PATH without wmux's WSL codex shim directory (a no-op off WSL).
__wmux_codex_strip_path() {
  local __wmux_rest="$PATH:" __wmux_d __wmux_clean=''
  while [ -n "$__wmux_rest" ]; do
    __wmux_d=\${__wmux_rest%%:*}
    __wmux_rest=\${__wmux_rest#*:}
    [ "$__wmux_d" = "\${WMUX_WSL_BIN:-}" ] && continue
    __wmux_clean="\${__wmux_clean:+$__wmux_clean:}$__wmux_d"
  done
  printf '%s' "$__wmux_clean"
}

# What does this codex support? Asked once per binary (path + inode + mtime).
__wmux_codex_probe() {
  local __wmux_key __wmux_out
  __wmux_key="$1|$(command \\ls -lLi -- "$1" 2>/dev/null)"
  [ "\${__wmux_codex_probe_key-}" = "$__wmux_key" ] && return 0
  __wmux_out=$(${unsetAll}; "$1" --help 2>/dev/null </dev/null)
  case "$__wmux_out" in
    *--no-daemon*) __wmux_codex_nodaemon=1 ;;
    *) __wmux_codex_nodaemon=0 ;;
  esac
  __wmux_out=$(${unsetAll}; "$1" features list 2>/dev/null </dev/null)
  case "$__wmux_out" in
    *daemon_auto_start*) __wmux_codex_guard=1 ;;
    *) __wmux_codex_guard=0 ;;
  esac
  __wmux_codex_probe_key="$__wmux_key"
}`;
}

/** The dispatching body shared by both shells. `unsetAll` is the
 *  shell-specific statement that removes every WMUX_* variable; `lookup` is
 *  the shell's PATH search for codex. */
function codexSeedGuardBody(unsetAll: string, lookup: string): string {
  return `  local __wmux_bin __wmux_real __wmux_keep=0
  __wmux_bin=$(${lookup})
  if [ -z "$__wmux_bin" ]; then
    command codex "$@"
    return
  fi
  if [ "\${WMUX_CODEX_WRAP:-1}" = "0" ]; then
    "$__wmux_bin" "$@"
    return
  fi
  __wmux_codex_classify "$@"
  if [ "$__wmux_codex_kind" = pass ]; then
    "$__wmux_bin" "$@"
    return
  fi
  __wmux_real=$__wmux_bin
  if [ -n "\${WMUX_WSL_BIN:-}" ]; then
    __wmux_real=$(PATH=$(__wmux_codex_strip_path); ${lookup})
    if [ -z "$__wmux_real" ]; then
      "$__wmux_bin" "$@"
      return
    fi
  fi
  __wmux_codex_probe "$__wmux_real"
  case "$__wmux_codex_kind" in
    env) __wmux_keep=1 ;;
    tui)
      [ "$__wmux_codex_nodaemon" = 1 ] && set -- --no-daemon "$@"
      { [ "$__wmux_codex_guard" = 1 ] || [ "$__wmux_codex_nodaemon" = 1 ]; } && __wmux_keep=1
      ;;
    unknown)
      if [ "$__wmux_codex_guard" = 1 ]; then
        [ "$__wmux_codex_nodaemon" = 1 ] && set -- --no-daemon "$@"
        __wmux_keep=1
      fi
      ;;
  esac
  [ "$__wmux_codex_guard" = 1 ] && set -- -c features.daemon_auto_start=false "$@"
  if [ "$__wmux_keep" = 1 ]; then
    "$__wmux_bin" "$@"
  else
    ( ${unsetAll}; exec "$__wmux_real" "$@" )
  fi`;
}

const BASH_CODEX_SEED_GUARD = `# Codex shared-server seed guard (v12). Off with WMUX_CODEX_WRAP=0. Skipped on
# Git Bash and when the user already defines a codex function.
if [ -z "\${MSYSTEM:-}" ] && ! declare -F codex >/dev/null 2>&1; then
${codexSeedGuardHelpers('unset "${!WMUX_@}" 2>/dev/null')}

function codex {
${codexSeedGuardBody('unset "${!WMUX_@}" 2>/dev/null', 'type -P codex 2>/dev/null')}
}
fi`;

const ZSH_CODEX_SEED_GUARD = `# Codex shared-server seed guard (v12). Off with WMUX_CODEX_WRAP=0. Skipped when
# the user already defines a codex function.
if (( ! \${+functions[codex]} )); then
${codexSeedGuardHelpers("unset -m 'WMUX_*'")}

function codex {
  emulate -L zsh
${codexSeedGuardBody("unset -m 'WMUX_*'", 'whence -p codex 2>/dev/null')}
}
fi`;
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

# The $LASTEXITCODE the LAST prompt render saw (#1270). It is the only way to
# tell "a native command just ran and set this" from "this is left over from
# some native command earlier in the session" — see the prompt function.
$global:__wmux_prev_le = $LASTEXITCODE

# Stash the user's existing prompt function so we can wrap it instead of
# clobbering any customization (oh-my-posh, Starship, etc.).
if (-not (Get-Variable -Name '__wmux_prev_prompt' -Scope Global -ErrorAction SilentlyContinue)) {
    $global:__wmux_prev_prompt = (Get-Command prompt -CommandType Function -ErrorAction SilentlyContinue).ScriptBlock
}

# The OSC 7 sequence for the current location, or '' outside the FileSystem
# provider (a registry/cert location has no directory to report). Records what
# it reported in $global:__wmux_osc7_last so the mid-line hook below can tell
# whether the location moved since.
#
# Each path segment is percent-encoded (CodeRabbit review on #541): the
# daemon's parseOsc7Cwd unconditionally decodeURIComponent()s the payload, so
# a raw path containing a literal '%' (e.g. "build%20cache") would otherwise be
# silently corrupted by the decode. Splitting on '\\' first and encoding each
# segment keeps '/' as the literal path separator parseOsc7Cwd expects while
# %-escaping everything else: colons, spaces, unicode and literal '%' all
# round-trip through the decode.
#
# A scriptblock, not a function, and no cmdlets inside: the mid-line hook runs
# it from a PostCommandLookupAction, where calling a function or a cmdlet is
# itself a command lookup.
$global:__wmux_osc7_last = $null
$global:__wmux_osc7 = {
    $loc = $executionContext.SessionState.Path.CurrentLocation
    if ($loc.Provider.Name -ne 'FileSystem') { return '' }
    $global:__wmux_osc7_last = $loc.ProviderPath
    $segments = foreach ($segment in $loc.ProviderPath.Split([char]92)) { [Uri]::EscapeDataString($segment) }
    return [string][char]27 + ']7;file://' + $env:COMPUTERNAME + '/' + [string]::Join('/', [string[]]$segments) + [char]7
}

# OSC 7 in the middle of a command line (#1941). The prompt is the only other
# place the cwd is reported, so on 'cd X; claude' the program ran in X while
# wmux still held the folder from the last prompt. A daemon that died in that
# window recovered the pane in the old folder, and the Resume pill resumed
# that folder's conversation.
#
# Between Enter and the next prompt, a PostCommandLookupAction reports the
# location whenever it moved since the last report, before the next command
# starts. It disarms itself on the first program or script launch (the
# location is reported; that is the case that matters) and on the first lookup
# inside a function, script block or script body: the action runs for every
# lookup, which costs a command-heavy loop about 40% on 5.1, so it must not
# stay armed into one. LocationChangedAction would be simpler but does not
# exist in Windows PowerShell 5.1.
#
# A loop typed at the prompt (for/foreach/while) is the exception: its body's
# lookups are top level too, so the hook would stay armed for the whole loop
# (a 20,000-command loop ran about 2x slower). It therefore also disarms after
# 64 lookups on one line. Measured on 5.1: an armed lookup costs about 45 us, so
# the cap bounds the cost of a line at about 3 ms, and long hand-typed lines
# (pipelines, chains of ten commands) made at most 10 armed lookups. The
# consequence: a cd that is the 64th lookup on its line or later is reported at
# the next prompt, not immediately.
#
# An action the user already set is kept: it is chained while ours is armed and
# restored when ours disarms.
$global:__wmux_lookup_busy = $false
$global:__wmux_lookup_n = 0
$global:__wmux_lookup_absorb = $false
$global:__wmux_prev_lookup = $null
$global:__wmux_lookup = {
    param($__wmux_name, $__wmux_event)
    # $? as the command line left it. Every statement below resets $? to true.
    # After a terminating error or a Ctrl+C the host looks up Out-Default and
    # prompt with this action still armed, so the prompt saw true and reported
    # the failed command as D;0. It is re-created at the end of this body.
    $__wmux_ok = $?
    # The Write-Error at the end of this body is a lookup too and lands here.
    if ($global:__wmux_lookup_absorb) { $global:__wmux_lookup_absorb = $false; return }
    # Lookups made by the chained action land here again; neither it nor this
    # body may run for those.
    if ($global:__wmux_lookup_busy) { return }
    $global:__wmux_lookup_busy = $true
    $global:__wmux_lookup_n++
    try {
        # The property returns a delegate, not the scriptblock that was set,
        # and '&' cannot invoke a delegate. .Invoke() takes either.
        if ($global:__wmux_prev_lookup) { try { $global:__wmux_prev_lookup.Invoke($__wmux_name, $__wmux_event) } catch { } }
        $type = if ($__wmux_event.Command) { [string]$__wmux_event.Command.CommandType } else { '' }
        if ($__wmux_event.CommandOrigin -ne 'Runspace' -or $type -eq 'Application' -or $type -eq 'ExternalScript' -or $global:__wmux_lookup_n -ge 64) {
            & $global:__wmux_disarm_lookup
        }
        $loc = $executionContext.SessionState.Path.CurrentLocation
        if ($loc.Provider.Name -eq 'FileSystem' -and $loc.ProviderPath -ne $global:__wmux_osc7_last) {
            [Console]::Write((& $global:__wmux_osc7))
        }
    } catch {
    } finally {
        $global:__wmux_lookup_busy = $false
    }
    if (-not $__wmux_ok) {
        if ($ExecutionContext.InvokeCommand.PostCommandLookupAction -eq $global:__wmux_lookup) { $global:__wmux_lookup_absorb = $true }
        # The prompt's idiom: -ErrorAction Ignore sets $? to false and records
        # nothing in $Error. It must stay the last statement.
        Write-Error -Message 'wmux: last command failed' -ErrorAction Ignore
    }
}
$global:__wmux_arm_lookup = {
    $global:__wmux_lookup_busy = $false
    $global:__wmux_lookup_absorb = $false
    $global:__wmux_lookup_n = 0
    $current = $ExecutionContext.InvokeCommand.PostCommandLookupAction
    if ($current -ne $global:__wmux_lookup) {
        $global:__wmux_prev_lookup = $current
        $ExecutionContext.InvokeCommand.PostCommandLookupAction = $global:__wmux_lookup
    }
}
$global:__wmux_disarm_lookup = {
    if ($ExecutionContext.InvokeCommand.PostCommandLookupAction -eq $global:__wmux_lookup) {
        $ExecutionContext.InvokeCommand.PostCommandLookupAction = $global:__wmux_prev_lookup
    }
}
# Armed by the PSReadLine Enter handler below. Without PSReadLine the prompt
# arms it instead: the host then reads the line natively, with no command
# lookups between the prompt and the user's first command.
$global:__wmux_arm_at_prompt = $true

function global:prompt {
    # Capture $? and $LASTEXITCODE as the VERY FIRST statements. Any
    # comparison, assignment, or cmdlet call inside this function resets
    # $? to true — so a later 'elseif ($?)' check would always take the
    # success branch and report D;0 even after a failed command. This
    # same trap bites VS Code / Windows Terminal integrations; the fix
    # is to snapshot both variables before doing anything else.
    $__wmux_ok = $?
    $__wmux_le = $LASTEXITCODE

    # Which of the two snapshots actually describes the command that just ran
    # (#1270).
    #
    # $LASTEXITCODE is set ONLY by native commands, and it is never cleared. So
    # from the first native command onward it is non-null for the rest of the
    # session, and preferring it unconditionally — which is what this line used
    # to do — meant every cmdlet afterwards reported a stale number.
    # 'Get-Item Q:\\nope-xyz' after any earlier native command emitted D;0, and
    # that value feeds agent.lifecycle.exitCode.
    #
    # The other direction is just as wrong and is why '$? first, always' is not
    # the answer either: after 'cmd /c exit 7', a SUCCEEDING cmdlet leaves
    # $LASTEXITCODE at 7, so reporting it would mark a successful command failed.
    #
    # What separates the two cases is whether $LASTEXITCODE MOVED since the last
    # prompt. It did → a native command ran and that number is its exit code.
    # It did not → the last command was a cmdlet, the number is stale, and $?
    # is the only thing that knows how it went.
    #
    # The residual case: two native commands in a row exiting with the SAME
    # code. The second one's number has not moved, so its failure is reported as
    # 1 rather than its own code. Both are non-zero, the consumer is a
    # failed/succeeded signal, and exit 1 — far and away the most common failure
    # code — reports as exactly itself.
    $__wmux_le_moved = $__wmux_le -ne $global:__wmux_prev_le
    $ec = if ($__wmux_le_moved) { $__wmux_le } elseif ($__wmux_ok) { 0 } else { 1 }
    $global:__wmux_prev_le = $__wmux_le

    # The command line is over: the mid-line cwd hook (#1941) must not stay
    # armed into the prompt or the line editor.
    & $global:__wmux_disarm_lookup

    $esc = [char]27
    $bel = [char]7

    # D;<exit>  marks end of previous command.
    # A         marks start of the new prompt.
    $pre = "$esc]133;D;$ec$bel$esc]133;A$bel"

    # OSC 7: cwd report (issue #540). wmux treats OSC 7 as the authoritative
    # cwd source and turns prompt scraping off for good the first time it sees
    # one — so this hook MUST re-emit on every prompt (parity with the zsh
    # integration), or a single stray OSC 7 from a child program would freeze
    # the pane's tracked cwd. See $global:__wmux_osc7 for the encoding.
    $pre += & $global:__wmux_osc7

    # Re-assert the snapshot before delegating (#1267). Every statement above
    # reset $? to true, so the prompt we wrap would otherwise always see
    # "success" and an exit-code segment (oh-my-posh status, Starship) would
    # stay green after a failed command. $? is not assignable and the snapshot
    # cannot be deferred — any statement is enough to reset it — so the value
    # is re-created here instead.
    #
    # -ErrorAction Ignore is the variant with no side effects: unlike
    # SilentlyContinue it records nothing in $Error, which matters because
    # oh-my-posh reads the newest error record as exit code 1 and would mask
    # the real code. Ignore also never throws under $ErrorActionPreference =
    # 'Stop', on 5.1 and 7+ alike.
    #
    # This must stay the LAST statement before the delegation: any cmdlet call
    # in between (a Test-Path, say) resets $? straight back to true.
    if (-not $__wmux_ok) { Write-Error -Message 'wmux: last command failed' -ErrorAction Ignore }

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

    # Without PSReadLine nothing else runs between here and the user's line.
    if ($global:__wmux_arm_at_prompt) { & $global:__wmux_arm_lookup }

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
                # Arm the mid-line cwd hook (#1941) here, after the line
                # editor's own command lookups (PSConsoleHostReadLine and what
                # it calls) are behind us.
                & $global:__wmux_arm_lookup
            } catch {
                # Some host (constrained sub-shell, missing console, etc.)
                # blocked the call — fall back to plain AcceptLine via the
                # default binding by re-invoking it without the OSC write.
                try { [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine() } catch { }
            }
        } -ErrorAction SilentlyContinue
        if ($?) { $global:__wmux_arm_at_prompt = $false }
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

# After the user's rc (so an existing codex function is seen) and after the
# opt-out above (WMUX_SHELL_INTEGRATION=0 turns this off too).
${BASH_CODEX_SEED_GUARD}

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

# After the user's .zshrc (so an existing codex function is seen) and after the
# opt-out above (WMUX_SHELL_INTEGRATION=0 turns this off too).
${ZSH_CODEX_SEED_GUARD}

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
    // On a factory-default Windows client the effective policy is Restricted
    // and the dot-source fails (#1620); the policy args must precede -Command.
    return {
      args: [
        '-NoLogo', '-NoExit', ...windowsPowerShellPolicyArgs(shellPath),
        '-Command', `. '${paths.pwsh.replace(/'/g, "''")}'`,
      ],
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
