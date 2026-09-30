### Changed

- **The `input.send` reply reports the launch options a role added.** When a
  role binding rewrites a launch line, the reply now carries
  `enforcedOptions: { effort?, skipPermissions? }` next to `enforcedModel`:
  the effort flag (`--effort`, or Codex `-c model_reasoning_effort=…`) and
  the skip-permissions flag it actually added. Before, a pipe or MCP caller
  (the orchestrator's `terminal_send`) could not tell that its line had
  gained either. The field is optional, appears only when something was
  added, and is experimental for now, like `enforcedModel` and `note`. (#1681)
- **A pane shows when its role skips permission prompts.** The role badge on
  the pane's tab strip and the chip in the Fleet roster used to appear only
  for a role that pins a model, so a role that launches with
  `--dangerously-skip-permissions` (or Codex's bypass flag) looked like no
  role at all. They now also show for such a role, leading with a red
  "bypass", and the tooltip names the flag the launch carries. A role whose
  own extra args set a permission mode shows no "bypass", since its launch
  does not skip. `wmux role resolve` reports `skipPermissions` the same
  way. (#1681)
- **`npm run typecheck` also checks the MCP, CLI and daemon builds.** Those
  builds target older JavaScript versions (ES2020 for MCP) than the main
  type check, so a newer API such as `Object.hasOwn` in a shared file passed
  the type check and only failed when the MCP bundle was built. (#1681)

### Fixed

- **An explicit permission choice now wins over a role's skip permissions.**
  With "skip permissions" turned off on the resume chip or the recovery pill,
  a `--dangerously-skip-permissions` in the role's extra args was still
  appended, so the pane resumed in bypass mode anyway; it is now dropped, and
  the role's other args stay. A permission flag typed on the launch line
  itself (`claude --permission-mode plan`, Codex `-a`/`--ask-for-approval`,
  `-s`/`--sandbox`, `--approve-for-me`, or `-c approval_policy=…` /
  `-c sandbox_mode=…`) now keeps the role's skip flag off that line too, and
  drops the permission flags in the role's extra args, which used to be
  appended after the typed one and win. With no permission flag typed, one in
  the role's own args counts as the role's choice and stops the skip flag
  from being added. (#1681)
