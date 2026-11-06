//! The endpoints both hook bridges walk: the daemon's control pipe and main's
//! pipe, each with its own token and method, and the WMUX_PIPE_NAME override
//! that collapses the walk to one pipe. Who an override is addressed to, and
//! with which token, stays with each bridge.

use crate::paths;
use crate::rpc::Target;

pub const MAIN_METHOD: &str = "hooks.signal";
pub const DAEMON_METHOD: &str = "daemon.hooks.signal";

/// WMUX_PIPE_NAME, when set and not empty.
pub fn pipe_override() -> Option<String> {
    paths::env("WMUX_PIPE_NAME").filter(|p| !p.is_empty())
}

pub fn main_token() -> Option<String> {
    paths::read_token_file(&paths::auth_token_path())
}

pub fn daemon_token() -> Option<String> {
    paths::read_token_file(&paths::daemon_auth_token_path())
}

/// The walk without an override: the daemon first (when `with_daemon`,
/// WMUX_HOOKS_TO_MAIN is not "1", and it has a token), then main (when it has
/// a token). A target without a token has never run, so it is left out.
pub fn default_walk(with_daemon: bool) -> Vec<Target> {
    let mut targets = Vec::new();
    if with_daemon && paths::env("WMUX_HOOKS_TO_MAIN").as_deref() != Some("1") {
        if let Some(token) = daemon_token() {
            targets.push(Target {
                name: "daemon",
                pipe: paths::daemon_pipe_name(),
                token,
                method: DAEMON_METHOD,
            });
        }
    }
    if let Some(token) = main_token() {
        targets.push(Target {
            name: "main",
            pipe: paths::main_pipe_name(),
            token,
            method: MAIN_METHOD,
        });
    }
    targets
}
