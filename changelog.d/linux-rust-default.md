### Changed

- **Linux terminals run on the Rust engine by default.** On Linux, the desktop
  app and the wmux server now start the Rust terminal engine when nothing is
  saved and the installed build includes it, as Windows does. Before, Linux
  started Node unless you picked Rust. A saved engine choice is kept,
  `WMUX_TERMINAL_CORE` still overrides it, and Node is used when the Rust
  engine cannot load. Settings › Terminal engine can switch back to Node.
  (#PR)
