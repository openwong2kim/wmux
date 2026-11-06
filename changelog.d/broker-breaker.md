### Changed

- **A shared MCP broker that keeps crashing is switched off until wmux
  restarts.** With the broker enabled, wmux used to restart it after every
  crash, forever. After five failures in a minute, or eight in half an hour,
  it now stops, and agents start their own MCP server straight away.
  `wmux doctor` says so and names the tools that were running at the last
  crash. The broker also exits when the wmux app does instead of outliving
  it.
