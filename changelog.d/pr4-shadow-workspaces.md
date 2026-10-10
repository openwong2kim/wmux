### Added

- **Open another computer's workspaces from the computer column.** Selecting a
  paired computer now lists its workspaces in the sidebar, in that computer's
  own order, with the usual needs-you and error marks. Opening one shows its
  panes in the same split layout as on that computer, and you can read and
  type in them. Browser and editor tabs there show as "not shown" placeholders,
  and a session you already have open in another tab says where it is instead
  of opening twice. Until you pick one, the centre reads "Pick a workspace on
  <computer>"; an offline computer keeps its last list, muted. Closing one of
  these workspaces only stops watching it: nothing on the other computer is
  closed. They are never saved to the session and never show up in this
  computer's sidebar, keyboard switching or archive.
- **Workspaces with no terminal are listed.** A paired computer's `/api/workspaces`
  now also lists the workspaces its window shows that have no live terminal,
  as `empty` rows, so they appear in the list (they cannot be opened).

### Changed

- **Attached remote mirrors leave the sidebar.** With a computer paired, the
  computer column replaces the one-by-one "Attach remote workspace…" entry and
  the mirror rows in the workspace list. With no computer paired nothing
  changes.
