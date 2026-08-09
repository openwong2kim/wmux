### Security

- **Hardened privileged RPC client recognition.** The bundled-MCP and CLI allowlists now require source-qualified wire provenance, so an approved in-process UI plugin whose manifest name collides with a recognised host identity stays on its own declared permissions instead of inheriting the first-party method set. (GHSA-x2xm-9w7w-hh6p)
