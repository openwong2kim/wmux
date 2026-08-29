### Changed

- **Four browser-tool contracts an agent had to discover by trying them are now
  stated in the tool descriptions.** `browser_tabs` says that `selected`
  reports UI focus — always `false` on the `chrome` backend — and is not what
  decides which surface a tool with no `surfaceId` targets, so the only surface
  in a workspace is still reachable when it lists as `selected: false`.
  `browser_snapshot` says that `"aria"` output carries no refs and that
  `filter` applies to `"ai"` only; passing the two together now returns the
  full tree with a note saying the filter was ignored, instead of dropping the
  parameter in silence. `browser_evaluate` documents its return contract:
  blocking is a text scan (a blocked name inside a string or a comment is
  refused too), strings come back verbatim and everything else as JSON (DOM
  nodes, `Map`s and functions serialize to `{}`), a returned Promise is
  awaited, and top-level `await` is a syntax error.

### Removed

- **`browser_snapshot`'s `ref` parameter is gone from the schema.** It was
  described as "Reserved; not implemented yet" and was never read, so every
  agent paid to read it on its first call only to decide to ignore it.
