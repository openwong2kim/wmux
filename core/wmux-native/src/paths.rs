//! Endpoint and state-file discovery, mirroring the path helpers of
//! integrations/shared/bin/wmux-hooks-bridge.mjs (and through it
//! src/shared/constants.ts). A non-empty WMUX_DATA_SUFFIX is an instance
//! boundary: nothing here falls back to the unsuffixed production paths.

use crate::js::{decode_utf8_trimmed, lossy, JsStr};
use std::ffi::OsString;

/// An env var as Node's `process.env.X` sees it: None when unset.
pub fn env(name: &str) -> Option<String> {
    std::env::var_os(name).map(os_to_string)
}

/// `process.env.X` as UTF-16, for values that are forwarded in the envelope.
pub fn env_js(name: &str) -> Option<JsStr> {
    std::env::var_os(name).map(|v| os_to_js(&v))
}

/// `process.env.X || fallback`: empty counts as unset.
fn env_nonempty(name: &str) -> Option<String> {
    env(name).filter(|v| !v.is_empty())
}

#[cfg(windows)]
pub fn os_to_js(v: &std::ffi::OsStr) -> JsStr {
    use std::os::windows::ffi::OsStrExt;
    v.encode_wide().collect()
}

#[cfg(not(windows))]
pub fn os_to_js(v: &std::ffi::OsStr) -> JsStr {
    crate::js::js(&v.to_string_lossy())
}

fn os_to_string(v: OsString) -> String {
    lossy(&os_to_js(&v))
}

fn data_suffix() -> String {
    env("WMUX_DATA_SUFFIX").unwrap_or_default()
}

/// `os.homedir()`: HOME (USERPROFILE on Windows) whenever it is set, even to
/// an empty string, else the account database. std::env::home_dir alone would
/// replace an empty value with the account's real home, which is a different
/// instance's state, so the set-but-empty case is decided here.
fn os_homedir() -> String {
    homedir_from(env(if cfg!(windows) { "USERPROFILE" } else { "HOME" }), || {
        #[allow(deprecated)]
        std::env::home_dir()
            .map(|p| os_to_string(p.into_os_string()))
            .unwrap_or_default()
    })
}

fn homedir_from(var: Option<String>, account: impl FnOnce() -> String) -> String {
    var.unwrap_or_else(account)
}

fn home_dir() -> String {
    env_nonempty("USERPROFILE")
        .or_else(|| env_nonempty("HOME"))
        .unwrap_or_else(os_homedir)
}

pub fn wmux_home_dir() -> String {
    join(&[&home_dir(), &format!(".wmux{}", data_suffix())])
}

pub fn auth_token_path() -> String {
    join(&[&home_dir(), &format!(".wmux{}-auth-token", data_suffix())])
}

pub fn daemon_auth_token_path() -> String {
    join(&[&wmux_home_dir(), "daemon-auth-token"])
}

pub fn pipe_name() -> String {
    env_nonempty("WMUX_PIPE_NAME").unwrap_or_else(main_pipe_name)
}

/// The main pipe's derived name, ignoring WMUX_PIPE_NAME (getPipeName in
/// wmux-bridge.mjs, whose override is decided by the caller). On POSIX it
/// lives under `os.homedir()`, not under USERPROFILE || HOME.
pub fn main_pipe_name() -> String {
    if cfg!(windows) {
        return format!(r"\\.\pipe\wmux{}-{}", data_suffix(), username());
    }
    let home = os_homedir();
    join(&[
        if home.is_empty() { "/tmp" } else { &home },
        &format!(".wmux{}.sock", data_suffix()),
    ])
}

/// The daemon's own `daemon-pipe` hint first (the name it actually bound),
/// else the name derived within the same namespace.
pub fn daemon_pipe_name() -> String {
    if let Ok(bytes) = std::fs::read(join(&[&wmux_home_dir(), "daemon-pipe"])) {
        let hint = lossy(&decode_utf8_trimmed(&bytes));
        if !hint.is_empty() {
            return hint;
        }
    }
    if cfg!(windows) {
        return format!(r"\\.\pipe\wmux-daemon{}-{}", data_suffix(), username());
    }
    join(&[&wmux_home_dir(), "daemon.sock"])
}

/// A token file's trimmed content, or None when absent, unreadable or blank.
pub fn read_token_file(path: &str) -> Option<String> {
    let token = lossy(&decode_utf8_trimmed(&std::fs::read(path).ok()?));
    (!token.is_empty()).then_some(token)
}

/// `os.userInfo().username || 'default'` on Windows.
#[cfg(windows)]
pub fn username() -> String {
    #[link(name = "advapi32")]
    extern "system" {
        fn GetUserNameW(buffer: *mut u16, size: *mut u32) -> i32;
    }
    let mut buf = [0u16; 257];
    let mut len = buf.len() as u32;
    // SAFETY: buf is valid for `len` units; len receives the count incl. NUL.
    let ok = unsafe { GetUserNameW(buf.as_mut_ptr(), &mut len) } != 0;
    let name = if ok && len > 0 {
        lossy(&buf[..len as usize - 1])
    } else {
        String::new()
    };
    if name.is_empty() {
        "default".into()
    } else {
        name
    }
}

#[cfg(not(windows))]
pub fn username() -> String {
    unreachable!("the username only names a Windows pipe")
}

/// `path.join` for the host platform.
pub fn join(parts: &[&str]) -> String {
    let parts: Vec<&str> = parts.iter().copied().filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return ".".into();
    }
    if cfg!(windows) {
        normalize_win32(&parts.join("\\"))
    } else {
        normalize_posix(&parts.join("/"))
    }
}

/// `path.posix.normalize`.
pub fn normalize_posix(p: &str) -> String {
    let absolute = p.starts_with('/');
    let trailing = p.ends_with('/');
    let body = resolve_segments(p.split('/'), absolute).join("/");
    let mut out = if absolute { format!("/{body}") } else { body };
    if out.is_empty() {
        out.push('.');
    }
    if trailing && !out.ends_with('/') {
        out.push('/');
    }
    out
}

/// `path.win32.normalize` for drive-letter and UNC paths.
pub fn normalize_win32(p: &str) -> String {
    let p = p.replace('/', "\\");
    let (root, rest, absolute) = split_win32_root(&p);
    let trailing = rest.ends_with('\\');
    let mut body = resolve_segments(rest.split('\\'), absolute).join("\\");
    if body.is_empty() && !absolute {
        body.push('.');
    }
    if trailing && !body.is_empty() && !body.ends_with('\\') {
        body.push('\\');
    }
    format!("{root}{}{body}", if absolute { "\\" } else { "" })
}

fn split_win32_root(p: &str) -> (String, &str, bool) {
    let b = p.as_bytes();
    if b.len() >= 2 && b[0] == b'\\' && b[1] == b'\\' {
        // \\server\share is the root of a UNC path.
        let parts: Vec<&str> = p[2..].splitn(3, '\\').collect();
        if parts.len() >= 2 && !parts[0].is_empty() && !parts[1].is_empty() {
            let root = format!("\\\\{}\\{}", parts[0], parts[1]);
            return (root, parts.get(2).copied().unwrap_or(""), true);
        }
        return (String::new(), p.trim_start_matches('\\'), true);
    }
    if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        let rest = &p[2..];
        return (
            p[..2].to_string(),
            rest.trim_start_matches('\\'),
            rest.starts_with('\\'),
        );
    }
    (String::new(), p.trim_start_matches('\\'), p.starts_with('\\'))
}

fn resolve_segments<'a>(segments: impl Iterator<Item = &'a str>, absolute: bool) -> Vec<&'a str> {
    let mut out: Vec<&str> = Vec::new();
    for seg in segments {
        match seg {
            "" | "." => {}
            ".." if out.last().is_some_and(|s| *s != "..") => {
                out.pop();
            }
            ".." if absolute => {}
            s => out.push(s),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_home_variable_is_kept_not_replaced() {
        assert_eq!(homedir_from(Some(String::new()), || "/Users/real".into()), "");
        assert_eq!(homedir_from(None, || "/Users/real".into()), "/Users/real");
        // join() then drops the empty part: Node resolves `.wmux` against the cwd.
        assert_eq!(join(&["", ".wmux-x"]), ".wmux-x");
    }

    #[test]
    fn posix_join_matches_node() {
        assert_eq!(
            normalize_posix("/Users/a//.wmux/./x/../daemon-pipe"),
            "/Users/a/.wmux/daemon-pipe"
        );
        assert_eq!(normalize_posix("/../a/"), "/a/");
        assert_eq!(normalize_posix("a/../../b"), "../b");
        assert_eq!(normalize_posix(""), ".");
    }

    #[test]
    fn win32_join_matches_node() {
        assert_eq!(
            normalize_win32("C:\\Users\\Jane Doe/.wmux-x\\daemon-auth-token"),
            "C:\\Users\\Jane Doe\\.wmux-x\\daemon-auth-token"
        );
        assert_eq!(normalize_win32("C:\\a\\..\\..\\b"), "C:\\b");
        assert_eq!(normalize_win32("\\\\srv\\share\\u\\.wmux"), "\\\\srv\\share\\u\\.wmux");
        assert_eq!(normalize_win32("C:"), "C:.");
    }
}
