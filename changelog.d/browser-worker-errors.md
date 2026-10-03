### Fixed

- **Browser REPL worker failures retain their reason even when the thrown value is not an Error.** Strings, numbers and null no longer become a misleading `runtime crashed: undefined` message or throw inside the error handler, while error-like objects keep their string `message`. Values that cannot be printed use a safe fallback. Both active-run and idle failures report the reason when the next call starts a fresh runtime.
