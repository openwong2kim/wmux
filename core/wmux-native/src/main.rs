//! wmux-native: standalone native helpers for wmux.
//!
//!   wmux-native hook <flavour> [<Event>]   the Claude-compatible hook bridge
//!   wmux-native --version
//!
//! Each subcommand owns its own contract; `hook` never writes stdout and
//! always exits 0. More subcommands (an MCP shim) slot in beside it.

mod hook;
mod js;
mod os_random;
mod paths;
mod rpc;

/// Ownership marker: the hook installer recognises a wmux-written copy of this
/// binary by this text, as it does the bridge script by its first line.
pub const MARKER: &str = "wmux-managed: native-hooks";

const USAGE: &str = "usage: wmux-native hook <flavour> [<Event>]\n       wmux-native --version\n";

fn main() {
    // A panic must not print: hook output is read by the agent.
    std::panic::set_hook(Box::new(|_| {}));
    let mut args = std::env::args_os().skip(1);
    let sub = args.next();
    match sub.as_ref().and_then(|s| s.to_str()) {
        Some("hook") => {
            let flavour = args.next().map(|a| paths::os_to_js(&a));
            let event = args.next().map(|a| paths::os_to_js(&a));
            hook::run_hook_process(flavour, event);
        }
        Some("--version") => {
            println!("wmux-native {} ({MARKER})", env!("CARGO_PKG_VERSION"));
        }
        _ => {
            eprint!("{USAGE}");
            std::process::exit(2);
        }
    }
}
