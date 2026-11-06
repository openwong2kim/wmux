//! Process environment for unit tests. Tests run on parallel threads of one
//! process, so every test that sets an env var, or reads one through
//! `paths` or `std::env::temp_dir`, holds `lock()` for its whole run, and a
//! test that sets variables restores exactly what was there before.

use std::ffi::OsString;
use std::sync::{Mutex, MutexGuard};

static LOCK: Mutex<()> = Mutex::new(());

pub fn lock() -> MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Saves the named variables (set or unset) and puts them back on drop.
pub struct SavedEnv(Vec<(&'static str, Option<OsString>)>);

impl SavedEnv {
    pub fn new(vars: &[&'static str]) -> Self {
        SavedEnv(vars.iter().map(|v| (*v, std::env::var_os(v))).collect())
    }
}

impl Drop for SavedEnv {
    fn drop(&mut self) {
        for (var, value) in &self.0 {
            match value {
                Some(v) => std::env::set_var(var, v),
                None => std::env::remove_var(var),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_env_restores_set_and_unset_values() {
        let _env = lock();
        std::env::set_var("WMUX_TESTENV_A", "before");
        std::env::remove_var("WMUX_TESTENV_B");
        {
            let _saved = SavedEnv::new(&["WMUX_TESTENV_A", "WMUX_TESTENV_B"]);
            std::env::set_var("WMUX_TESTENV_A", "during");
            std::env::set_var("WMUX_TESTENV_B", "during");
        }
        assert_eq!(std::env::var("WMUX_TESTENV_A").as_deref(), Ok("before"));
        assert!(std::env::var_os("WMUX_TESTENV_B").is_none());
        std::env::remove_var("WMUX_TESTENV_A");
    }
}
