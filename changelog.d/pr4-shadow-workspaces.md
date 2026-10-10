### Added

- **Switch computers from the sidebar title.** Once another computer is paired
  for its workspaces, the sidebar title reads "Workspaces ▾" and opens a menu
  of this computer and each paired PC, with whether it is online, offline
  (and when it was last seen) or needs pairing again, and how many things
  there need you. A small badge beside the title counts what needs you on the
  computers you are not looking at. Each PC's settings in that menu mute its
  notifications, open the Remote page or pair again, and say whether this
  computer can type there and how to revoke it. With the sidebar collapsed,
  one icon at the top of the rail opens the same menu. Alt+Shift+Up/Down moves
  between computers and Alt+Shift+Home returns to this one; both can be moved
  in Settings › Shortcuts. With no paired PC nothing changes.
- **Open another computer's workspaces.** Selecting a
  paired computer now lists its workspaces in the sidebar, in that computer's
  own order, with the usual needs-you and error marks. Opening one shows its
  panes in the same split layout as on that computer, at your usual font
  size, with what is on its screen right away, and you can read and type in
  them. Splitting or adding panes is left to that computer. Browser and editor tabs there show as "not shown" placeholders,
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
  computer switcher replaces the one-by-one "Attach remote workspace…" entry and
  the mirror rows in the workspace list. With no computer paired nothing
  changes.
