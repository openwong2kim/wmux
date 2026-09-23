### Changed

- **The wmux MCP tool list is about 9% smaller.** Every tool in `tools/list` carried a JSON Schema `$schema` stamp (draft-07) and `execution: { taskSupport: "forbidden" }`. Both only restate what the protocol already assumes when they are absent, so wmux no longer sends them. Tool names, descriptions, parameters and behaviour are unchanged. Each session pays roughly 7 KB less context for the full profile and about 4 KB less for the core and commander profiles.
