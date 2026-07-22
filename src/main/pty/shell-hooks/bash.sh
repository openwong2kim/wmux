# wmux shell integration hook for Bash (Git Bash / WSL / Linux)
# Emits OSC 7 (CWD) and OSC 7727 (git branch) via PROMPT_COMMAND.

# --rcfile replaces ~/.bashrc, so load the user's file before installing wmux
# hooks. The guard prevents recursion if the user's rc delegates back here.
if [ -r "$HOME/.bashrc" ] && [ -z "${__WMUX_BASHRC_SOURCED:-}" ]; then
    export __WMUX_BASHRC_SOURCED=1
    . "$HOME/.bashrc"
fi

# Guard: skip if already loaded
[ "$WMUX_SHELL_HOOK_ACTIVE" = "1" ] && return 2>/dev/null
export WMUX_SHELL_HOOK_ACTIVE=1

__wmux_prompt_hook() {
    local exit_code=$?
    printf '\e]133;D;%d\a\e]133;A\a' "$exit_code"
    # --- OSC 7: Current Working Directory ---
    # Build the path so it carries exactly the leading-slash shape parseOsc7Cwd
    # expects AFTER the host segment (the printf format is file://%s%s, no
    # separator — the leading slash is part of $uri_path):
    #   POSIX         "/home/me"
    #   Windows drive "/C:/Users/me"
    local uri_path
    if command -v cygpath >/dev/null 2>&1; then
        # Git Bash / MSYS / Cygwin: $PWD is a POSIX mount path (/c/Users/me) that
        # the Windows host can't resolve — convert to a mixed Windows path.
        uri_path="/$(cygpath -m "$PWD" 2>/dev/null)"
    else
        # Native Linux / macOS / WSL: $PWD is already the real POSIX path. For a
        # WSL pane we emit it as-is (not the \\wsl.localhost\ UNC form) so it
        # round-trips through 'wsl.exe --cd' on the next split and reads cleanly.
        uri_path="$PWD"
    fi
    printf '\e]7;file://%s%s\a' "${HOSTNAME:-localhost}" "$uri_path"

    # --- OSC 7727: Git branch (best-effort) ---
    if command -v git >/dev/null 2>&1; then
        local branch
        branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
        if [ $? -eq 0 ] && [ -n "$branch" ]; then
            printf '\e]7727;%s\a' "$branch"
        fi
    fi
}

__wmux_preexec() {
    printf '\e]133;C\a'
}

# Bash 4.4+: expanded after Enter and immediately before command execution.
PS0='$(__wmux_preexec)'

# Append to PROMPT_COMMAND, preserving any existing value.
if [ -z "$PROMPT_COMMAND" ]; then
    PROMPT_COMMAND="__wmux_prompt_hook"
else
    PROMPT_COMMAND="__wmux_prompt_hook;${PROMPT_COMMAND}"
fi
