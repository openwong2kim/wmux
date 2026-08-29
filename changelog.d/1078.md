### Changed

- **Browser tool descriptions are leaner, so every agent session starts
  cheaper.** An MCP host loads the whole tool list into the system prompt
  before an agent does any work, and wmux ships 39 `browser_*` tools — a fixed
  cost paid on every single session. Their descriptions carried duplicated
  sentences, repeated targeting advice, and implementation notes an agent
  cannot act on. Those are gone: the `browser_*` tool definitions now weigh
  20.6% less (25,684 → 20,399 characters, roughly 6,400 → 5,100 tokens), and
  the full wmux tool list dropped from ~19,700 to ~18,400 tokens. Every
  parameter, type, and enum is unchanged, as are the behavioural contracts the
  wording exists to protect — the upload sandbox, the `browser_evaluate`
  prompt-injection block, sensitive-domain cookie and storage rules, the
  `browser_screenshot` `browser_open` prerequisite, and the rule that a
  browser surface is addressed only by its opaque `surfaceId`.
- `node scripts/measure-mcp-tokens.mjs` reports the per-tool token cost of the
  MCP surface, so this budget can be checked rather than guessed.
