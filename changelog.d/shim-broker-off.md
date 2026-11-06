### Changed

- **Agents start without a 3-second wait when the shared MCP broker is not
  there.** With the broker enabled, an agent's native MCP launcher used to
  dial it ten times, 300 ms apart, before falling back to its own server,
  so every agent started while wmux was closed waited about three seconds.
  It now falls back on the first try when there is nothing to dial, and at
  once when wmux has marked the broker off.
