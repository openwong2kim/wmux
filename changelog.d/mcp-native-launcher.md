### Changed

- **With the shared MCP broker turned on, agents start a native launcher.**
  When `WMUX_MCP_BROKER=1`, wmux copies its native launcher next to the stable
  MCP bundle and registers it for each agent, after checking that it runs on
  this machine. A launcher that does not run is put back or removed, and the
  agents get the Node launcher instead. `wmux mcp register` now makes the same
  choice, so it no longer switches a working native entry back to Node.
