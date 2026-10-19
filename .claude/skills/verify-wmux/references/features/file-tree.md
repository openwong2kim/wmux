# File tree

The file tree is a column beside the panes that lists the focused pane's folder (widened to its git repository root). Users expand folders, filter by name, refresh, and click a file to open it read-only in a viewer tab of the active pane.

## Sub-features

- `ft-toggle`: show/hide the column.
- `ft-root`: root = focused pane's cwd (then workspace cwd), widened to the git top level.
- `ft-expand`: folders expand lazily (`aria-expanded`).
- `ft-open`: clicking a file adds a tab named after it with a View/Edit viewer; clicking again switches to that tab.
- `ft-filter`: "Filter by name" toggle and input.
- `ft-refresh`: "Refresh" button (it also polls and watches).
- `ft-menu`: row context menu: Open, Insert path, Copy path, Copy relative path, Open in Finder.

## How to get to it (user POV)

- The agent bar's "Files" button (`data-toolbar-action="file-tree"`); the column's own header has a close button (`data-file-tree-close`).
- Shortcut ⇧⌘E (Ctrl+Shift+E); palette "Toggle File Tree".

## Driving it with control-wmux

Preconditions:

- Baseline state; the terminal has `cd`'d into a scratch directory you created that is not inside a git repo, containing a known file, e.g. run in the pane `mkdir -p /tmp/wmux-verify-<run> && cd /tmp/wmux-verify-<run> && printf 'verify-file-body\n' > note.txt` (see terminal.md for `type` + `press Enter`).

- **Show the tree.** The toggle is the agent bar's Files button (`[data-toolbar-action="file-tree"]`); the bar is revealed on approach, so drive it by its shortcut. Run `control-wmux press --key Meta+Shift+e` (Control+Shift+e off macOS), then `control-wmux wait-settle --selector '#wmux-file-tree'`. `control-wmux inspect --js "({root: document.querySelector('[data-file-tree-root]')?.title, pressed: document.querySelector('[data-toolbar-action="file-tree"]').getAttribute('aria-pressed')})"` gives the scratch path and `"true"`.
- **Open a file.** Run `control-wmux click --selector '[data-file-tree-row="file"][title$="/note.txt"]'`, then `control-wmux wait-settle`. `control-wmux inspect --js "({tabs: [...document.querySelectorAll('.wmux-surface-tab')].map(t => t.textContent), body: document.querySelector('pre')?.textContent})"` lists a `note.txt` tab and `verify-file-body`. The row has `aria-selected="true"`.
- **Filter.** Run `control-wmux click --selector '[data-file-tree-filter-toggle]'`, then `control-wmux type --text note --selector '[data-file-tree-filter]'`. Only matching rows remain (`[data-file-tree-no-match]` appears for a miss).
- **Hide.** Press the shortcut again; `#wmux-file-tree` is gone and `aria-pressed` is `"false"`.
- **Proof.** `control-wmux snapshot --selector '#wmux-file-tree' --as tree` shows `tree "<folder name>"` with the rows.

## Gotchas

- The root is widened to the git top level: inside this repo the tree shows the whole checkout, in `~` it shows your home folder (and every name lands in the snapshot). Use a scratch folder.
- The toggle's aria-label stays "Show file tree" when open; assert `aria-pressed` or `#wmux-file-tree`.
- The column is `inert` while another rail page (Settings, Fleet, …) is in front.
- The viewer never saves; Edit mode is local only.
- "Open in Finder" opens the real Finder; the Copy actions write the system clipboard; "Insert path" types into the terminal.
- Tree visibility and width are saved in the session, so they carry over within one profile.
