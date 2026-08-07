### Fixed

- **Adding or removing a remote host no longer freezes the app on Windows.**
  The registry of remote hosts is rewritten on every change, and each rewrite
  went through an in-place secure write — which on Windows rebuilds the file's
  DACL through PowerShell, measured at 1.8 to 3.8 seconds under antivirus. That
  stall landed on the × button in the attach modal. The registry is now written
  to a fresh file that is hardened before it replaces the old one, so the cost
  is the fast path instead, the write is atomic, and the credentials it holds
  are never published unhardened.
