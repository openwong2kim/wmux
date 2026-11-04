### Added

- **The phone knows when a tap focused a text field.** A tap on the phone's
  browser preview now answers with `focus: {editable, kind}` — whether the
  element the tap focused takes typed text, and what kind of field it is
  (`text`, `password`, `email`, `number`, `tel`, `url`, `search`,
  `textarea` or `contenteditable`) — so the phone can raise its keyboard.
  The live browser stream also sends a `focus` event whenever the focused
  field changes, including when a page's script moves focus or a new page
  loads. Only the kind is sent, never what a field holds, its name, label
  or placeholder; it is read where page scripts cannot see or change it. A
  field inside a frame from another origin reads as not editable.
  (#PENDING)
