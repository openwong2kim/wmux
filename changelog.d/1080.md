### Fixed

- `browser_snapshot`'s `full` parameter documents itself again — the tool-description
  slimming in the previous release left it with no description at all, so nothing said
  what it was for.
- The browser tools now say that password field values read as `[redacted:password]`.
  The redaction shipped without a word about it, and an agent reading a snapshot could
  reasonably conclude its input had failed, or guess the wrong rule for which fields are
  masked. `browser_type` likewise notes that it replaces an existing value rather than
  appending to it.
