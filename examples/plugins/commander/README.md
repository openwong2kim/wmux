# Commander — Files

A bundled, dependency-free wmux rail page inspired by MDIR and Norton Commander.
Install Files from Settings > Plugins > Discover, review the permissions, then
open its rail item. No build step or external resources are needed.

The default two panels start at the active terminal pane's working directory.
Use Ctrl+1/2/3 for one, two or three panels, Tab/Shift+Tab to change panel,
and Alt+1–9 to jump to a workspace pane's folder. The toolbar swaps the first
two panels and offers the same quick slots and layout controls. MDIR file type
colours are optional and off by default. Theme tokens follow the host.

Arrow keys, PageUp/PageDown, Home/End, Enter and Backspace navigate. Space or
Insert toggles a mark and moves down; `*` inverts marks and `+`/`-` select by
wildcard (`*`, `?`). Type a name prefix to jump; `s` cycles name/size/date order.
Ctrl+R refreshes. Large lists use windowing; the host lists at most 10,000
entries and the panel calls out that limit. Mode shows kind and owner `rwx`
bits, not an effective-access guarantee.

- F2: rename the cursor entry in its current folder.
- F3: text viewer (up to 1 MB, binary files identified).
- F5/F6: copy/move marks, or the cursor entry, to the next visible panel.
- F7: create a folder.
- F8: move marks or the cursor entry to the operating system Trash.
- F10: go to a folder typed in a prompt (absolute, or relative to the panel).
- Esc: close the dialog; during a job, request cancellation.

Operations require confirmation in the page. Copy/move offer skip/overwrite
conflict choices and display progress with Cancel. At most 32 sources are
accepted per operation. Cancellation stops future chunks, removes partial files
and retains completed files; it does not roll back earlier work. A skipped
move source stays in place. All panels refresh after operations. No terminal
content, shell execution, network, permanent-delete or file editing API is used.

Permissions: `ui.rail-page`, `pane.read` (workspace pane cwd and active pane),
`fs.read` (folder listing and text viewing), `fs.write` (local mutations and job
control). These filesystem grants are not path-scoped: the plugin can read any text
file outside the host's refusal list (credential folders, `.env` files, private
keys, CLI tokens, shell history, wmux's own data) and nonlocal paths. Review permissions
before enabling. Symlinks copy as links without traversing folder targets.

MIT licensed; see LICENSE.
