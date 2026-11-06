### Fixed

- **Settings no longer changes your real Claude settings from an isolated or
  development instance.** Installing or updating the hook bridge, updating an
  account's hooks, and allowing the worker tools from Settings wrote
  `~/.claude/settings.json` even in a wmux started with `WMUX_DATA_SUFFIX` or
  from a source checkout, which changed what your installed wmux runs. Those
  buttons now say why they did nothing there; `wmux setup-hooks` in a terminal
  is still available when you mean it.
