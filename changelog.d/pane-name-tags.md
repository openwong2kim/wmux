### Added

- **Point an agent at a pane by its name: `#w1-2` or `#backend`.** Every pane already shows a unique name in its header (`w1-2`, plus the agent running in it) or the name you gave it. Type that name with a `#` to an agent and it can pass it straight to the wmux tools — `terminal_send`, `terminal_read`, the `pane_*` tools and `send_message` (as `to`, `pane_id` or `surface_id`) all accept it where they used to need a long pane, surface or terminal id. Before, targeting a pane meant pasting a block of ids from the pane header. `pane_list`, `a2a_discover` and `a2a_whoami` now report each pane's `paneName` and `paneTag`, and a name only reaches what its ids could, with the same checks.
- **Dragging a pane header into a wmux terminal types just its tag.** Drop the pane header on a terminal and it inserts `#w1-2 ` instead of the full block of ids, ready for the prompt you are writing to an agent. Dropping it on another app still gives the full description, which now also lists the pane tag (and the pane's name when you named it).

### Changed

- **Pane names must be one word and unique.** Because a pane name is now an address, renaming a pane refuses a name with spaces, `#` or `@`, a name that starts with a digit, one shaped like an automatic name (`w1-2`), or one another open pane already uses (ignoring case). The rename field says which rule it broke instead of quietly going back to the old name, and an agent setting a label through `pane_metadata` gets the same reason. Names you set before keep working as they are.
