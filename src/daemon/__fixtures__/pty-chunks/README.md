# PTY output chunks recorded on Windows

Raw PTY output from a Claude Code pane on Windows, kept with its original chunk boundaries and timing. Each chunk is what the daemon's `DaemonPTYBridge` `onOutput` handler received: one ConPTY read, after the OSC mark rewrite. The agent detector, the ring buffer and the interpreter read exactly these chunks. Use them to replay ConPTY chunking in detector tests; `load.ts` reads them.

| File | Engine | Scenario | Chunks | Bytes | Last chunk | Agent state (OSC 7501), in seconds |
|---|---|---|---|---|---|---|
| `rustpty-claude-burst.jsonl.gz` | Rust PTY (vendored portable-pty) | Claude runs `seq 1 4000` and prints the output | 504 | 37,750 | 48.8 s | working 2.9, done 48.8 |
| `rustpty-claude-permission.jsonl.gz` | Rust PTY | Claude runs `seq 1 4000`, then asks permission for `seq 1 3 > out.txt`; answered with `1` at 22.0 s | 360 | 29,119 | 32.7 s | working 2.9, blocked 17.4, working 22.5 |
| `nodepty-claude-burst.jsonl.gz` | node-pty | The same burst; the reply repeats the output | 404 | 30,283 | 35.3 s | working 3.0, done 35.3 |
| `nodepty-claude-permission.jsonl.gz` | node-pty | The same permission take; answered with `1` at 15.1 s | 252 | 24,689 | 25.8 s | working 3.1, blocked 8.3, working 15.6 |

**The permission takes end mid-turn.** They stop about 10 s after the answer, while Claude is still working: they hold the working → blocked → working edges, but no `done`.

**No Codex recordings:** the Codex account was close to its usage limit when these were made.

## Format

Each file is gzip'd JSON Lines.

Line 1 is a header:

```json
{"format":"wmux-pty-chunks/1","backend":"rustpty","wmuxSha":"3cb88f0c2","agent":"claude","agentVersion":"2.1.323","cols":118,"rows":44,"startedAt":null}
```

- `backend`: `rustpty` or `node-pty`.
- `cols` and `rows`: the pane size in force when the take starts.
- `startedAt`: always null; no wall-clock time is kept.

Every following line is one of:

- `{"t": 12.345, "b64": "..."}`: one chunk, as base64 of the raw bytes.
- `{"t": 12.345, "resize": {"cols": 120, "rows": 40}}`: the pane was resized. None of these takes has one.
- `{"t": 12.345, "input": "submit prompt: ..."}`: a note of what the recorder typed or pressed at that moment. It is a marker only: the keystrokes themselves are not in the stream.

`t` is milliseconds since the first chunk of the take. Lines are in `t` order.

## How they were recorded

- **Build:** a packaged wmux build of `3cb88f0c2` with the Rust terminal core included (`WMUX_PACKAGE_TERMINAL_CORE=1`). One local change, not committed: a tap in `DaemonPTYBridge`'s `onOutput`, right after the mark rewrite. It appended each chunk, with a high-resolution timestamp, to a JSON Lines file per session, and recorded every PTY resize the same way.
- **Instance:** an isolated wmux instance (its own data suffix) on Windows 11. The engine was switched between Rust and node-pty through `terminal-core.json`, with a daemon restart.
- **Agent:** Claude Code 2.1.323 on Haiku, in a throwaway git repository. The prompts only print; the permission takes run in manual permission mode.
- **Trimming:** each take starts about 3 s before the prompt is submitted.
  - The burst takes end at Claude's `done`.
  - The permission takes end about 10 s after the answer.

## What was scrubbed

Scrubbing ran on each take's whole byte stream before it was split back at the original boundaries. Every replacement has the same byte length as what it replaces, so chunk lengths, boundaries and cursor columns are exact. Replaced:

- the account's user name and the machine's host name;
- the account's e-mail address;
- the organisation name shown in Claude Code's status line;
- the recording folder's path, by `X:\scratch\fixtures\repo0`;
- every UUID (session and request ids), by `00000000-0000-0000-0000-000000000000`.

The decoded text of every take was then read through by hand for:
- home paths and other local paths;
- URLs and API hosts;
- anything echoed from the account's own instructions.

None remain. One earlier take was dropped and recorded again: Claude had repainted an earlier turn that listed a local install folder.

What stays:
- the agent's replies, in the language the account is set to;
- the status line's usage percentages and its reset clock.

`src/daemon/__tests__/ptyChunkFixtures.test.ts` pins each file's chunk count and byte total, and checks that its base64 is canonical and its lines are in order.
