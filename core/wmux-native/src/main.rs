//! wmux-native: standalone native helpers for wmux.
//!
//!   wmux-native hook <flavour> [<Event>]   the Claude-compatible hook bridge
//!   wmux-native <…/wmux-hooks-bridge.mjs> <flavour> [<Event>]   the same: the
//!       argv the installer writes, so older wmux builds recognise the entry
//!   wmux-native claude-hook <Event> [flags…]   the Claude hook bridge
//!       (unix only; elsewhere it is the usage below)
//!   wmux-native --version | --help
//!
//! Each subcommand owns its own contract; `hook` never writes stdout and
//! always exits 0. More subcommands (an MCP shim) slot in beside it.
//!
//! Any other argv also exits 0, with the usage on stderr: hook hosts read
//! exit 2 as "block this action", so a typo, a non-UTF-8 argument or a newer
//! subcommand run by an older copy must never produce it.

// The Claude hook is unix only: Windows Claude hooks stay on Node.
#[cfg(unix)]
mod claude;
#[cfg(unix)]
mod claude_hook;
#[cfg(unix)]
mod claude_rpc;
#[cfg(unix)]
mod claude_transcript;
#[cfg(unix)]
mod claude_where;
// Only the unix-only Claude hook uses most of it.
#[cfg_attr(windows, allow(dead_code))]
mod fsx;
mod hook;
mod js;
mod os_random;
mod paths;
mod rpc;
#[cfg(unix)]
mod sha256;
mod targets;
#[cfg(test)]
mod testenv;
#[cfg(unix)]
mod unix_sys;

/// Ownership marker: the hook installer recognises a wmux-written copy of this
/// binary by this text, as it does the bridge script by its first line.
pub const MARKER: &str = "wmux-managed: native-hooks";

/// The Node bridge's file name (SHARED_HOOKS_BRIDGE_BASENAME in hookFlavours.ts).
const BRIDGE_BASENAME: &str = "wmux-hooks-bridge.mjs";

const USAGE: &str =
    "usage: wmux-native hook <flavour> [<Event>]\n       wmux-native claude-hook <Event> [flags…]\n       wmux-native --version | --help\n";

fn main() {
    // A panic must not print: hook output is read by the agent.
    std::panic::set_hook(Box::new(|_| {}));
    let mut args = std::env::args_os().skip(1);
    let sub = args.next();
    let sub_text = sub.as_ref().map(|s| s.to_string_lossy());
    // The basename of a `/` or `\` path, as the installer's ownership check reads it.
    let names_bridge = sub_text.as_deref().and_then(|s| s.rsplit(['/', '\\']).next()) == Some(BRIDGE_BASENAME);
    match sub.as_ref().and_then(|s| s.to_str()) {
        _ if names_bridge => {
            let flavour = args.next().map(|a| paths::os_to_js(&a));
            let event = args.next().map(|a| paths::os_to_js(&a));
            hook::run_hook_process(flavour, event);
        }
        Some("hook") => {
            let flavour = args.next().map(|a| paths::os_to_js(&a));
            let event = args.next().map(|a| paths::os_to_js(&a));
            hook::run_hook_process(flavour, event);
        }
        #[cfg(unix)]
        Some("claude-hook") => claude_hook::run_process(args.collect()),
        Some("--version") => {
            println!("wmux-native {} ({MARKER})", env!("CARGO_PKG_VERSION"));
        }
        Some("--help") => print!("{USAGE}"),
        _ => eprint!("{USAGE}"),
    }
}
