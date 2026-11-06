### Fixed

- **Settings no longer changes your real Claude settings from an isolated or
  development instance.** Installing or updating the hook bridge, updating an
  account's hooks, allowing the worker tools and installing the status line
  from Settings wrote `~/.claude/settings.json` (and account copies of it)
  even in a wmux started with `WMUX_DATA_SUFFIX` or from a source checkout,
  which changed what your installed wmux runs. Those buttons now say why they
  did nothing there; `wmux setup-hooks` and `wmux setup-statusline` in a
  terminal are still available when you mean it.
