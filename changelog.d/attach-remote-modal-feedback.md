### Fixed

- **Pairing a remote host now actually shows you the host you just paired.**
  The Attach remote workspace modal registered the host and then sat there:
  the right-hand pane kept rendering its nothing-selected state, which was
  wired to the paste-URL placeholder, so a successful pair looked exactly
  like a no-op and told you to go paste a URL you had just avoided needing.
  A successful pair (or Add host) now selects that host and lists its
  workspaces straight away.

- **The modal's empty states say what is actually going on.** "No host
  selected" and "no hosts registered yet" are now distinct messages instead
  of a shared paste-URL instruction, and a host whose panes are all closed
  explains that the workspace list is built from panes open right now,
  instead of rendering a blank pane.

- **Enter submits the pairing and paste-URL forms.** Both were mouse-only —
  typing a host address and a pairing code and pressing Enter did nothing.
  Enter is ignored while the form is incomplete or in flight, matching the
  button's own disabled state, and mid-IME Enter still commits the
  composition rather than submitting.
