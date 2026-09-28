# Phone decision parity: PR0 measurement findings

Captured 2026-09-28 on macOS with codex-cli 0.157.1 and opencode 1.18.30.
PR0 is measurement only. It changes no runtime code. Outputs:

- `src/daemon/web/__tests__/fixtures/codex-server-requests.json`: Codex
  ServerRequest shapes, responses, and the relay frame sequence.
- `src/daemon/approvals/__tests__/fixtures/terminal-prompts/codex-approval-{exec,patch}-01.json`:
  Codex approval overlays, pinned as unparsed in `terminalPromptFixtures.test.ts`.
- KEYS.md, Codex section.
- `codexRelayPolicy.test.ts`: pins that the relay forwards the TUI's answer
  frames.

## Setup

Nothing touched the owner's wmux instance, `~/.codex`, or `~/.config/opencode`.
The harness scripts stayed in a scratch directory and are not committed.

- **Codex.** `codex app-server --listen unix://…` ran in a scratch `CODEX_HOME`
  against a loopback fixture Responses provider, with no login.
  `approval_policy = "on-request"`, `sandbox_mode = "read-only"`. 0.157.1
  rejects `"untrusted"` with "no longer supported; remove this setting". Command
  approvals were reached with `exec_command` + `sandbox_permissions:
  "require_escalated"`. File-change approvals were reached with an `apply_patch`
  heredoc through `exec_command`, because the fallback model metadata offers no
  `apply_patch` tool.
  The TUI chain was `codex --remote` → `createCodexTuiRelay` (bundled from this
  tree, with the policy on) → a logging/injecting proxy → app-server. Direct
  measurements used three plain WebSocket clients:
  - A started the thread.
  - B ran only `initialize`.
  - C ran `thread/resume` after the first turn.
- **OpenCode.** `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` and
  `XDG_CACHE_HOME` pointed at scratch directories. A project-local
  `opencode.json` set a fake OpenAI-compatible loopback provider and
  `"permission": {"bash": "ask"}`. A scratch TUI plugin (loaded through the
  scratch `tui.json`) did three things:
  - exposed `api.state.session.permission/question(id)` for any session id;
  - exposed `api.client.permission.reply`, `question.reply` and
    `question.reject`, plus `route.navigate`;
  - logged `permission.*` and `question.*` events.

  Screens were read from a headless xterm (120x40).

## Codex results

| Question | Result |
| --- | --- |
| ServerRequest methods (0.157.1 `generate-ts`) | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`, `item/permissions/requestApproval`, `item/tool/call`, `account/chatgptAuthTokens/refresh`, `attestation/generate`, `currentTime/read`, legacy `applyPatchApproval` / `execCommandApproval` |
| Observed live | Command and file-change approvals and MCP elicitation in the default configuration. `requestUserInput` and `permissions/requestApproval` only behind development feature flags (below). Params and responses are in the fixture |
| Command approval | Params: `threadId`, `turnId`, `itemId`, `command`, `cwd`, `reason`, `commandActions`, `proposedExecpolicyAmendment`, `availableDecisions`. For an escalation, `availableDecisions` = `accept`, `{acceptWithExecpolicyAmendment}`, `cancel`, with **no `decline`** |
| File change approval | Params: `threadId`, `turnId`, `itemId`, `reason`, `grantRoot`. There is no diff and no `availableDecisions`. An injected `decline` was accepted: the file was not written and the turn went on |
| What the TUI sends | `Enter` on "Yes, proceed" → `{"decision":"accept"}`. `Esc` ("No, and tell Codex what to do differently") → `{"decision":"cancel"}` for both kinds. The turn is interrupted |
| MCP tool approval | Arrives as `mcpServer/elicitation/request` `mode:"form"` with `_meta.codex_approval_kind:"mcp_tool_call"` and `persist:["session","always"]` |
| MCP form elicitation | `message` + `requestedSchema`. Answer: `{action, content, _meta}` |
| `requestUserInput` | Not sent in Default mode (the call returned without a request); with `features.default_mode_request_user_input` (under development) it was sent. Plan mode was not run. `questions[].isOther` is set by the server. Answer: `{answers:{<id>:{answers:[label]}}}` |
| `permissions/requestApproval` | Only with `features.request_permissions_tool` (under development) |
| Request ids | Small integers (0, 1, 2, …) that restart with the app-server process |
| Fan-out (broadcast) | **Yes, to subscribers.** C received the same request with the same id. B (not subscribed) received nothing. `serverRequest/resolved` goes to every subscriber |
| Duplicate / late answer | Ignored with no frame at all: no error, and the server stays up |
| Response injected on the TUI's upstream | The server sent `serverRequest/resolved`, and **the TUI closed the overlay by itself**. Enter pressed afterwards sent nothing, so the TUI never produced a late duplicate. The TUI adds no "You approved/declined" history line for an answer it did not give |
| Does the relay pass the TUI's answers? | Yes. Live, the TUI's `{"id":0,"result":{"decision":"accept"}}` to the request it had just received crossed the relay with its policy on |
| Approval overlay fixtures | `looksLikeApprovalPrompt` = true, `parseTerminalPrompt` = null (pinned) |

Raw frame sequence on the TUI connection (thread id elided):

```
server->client  {"method":"item/fileChange/requestApproval","id":1,…}
injected->server {"id":1,"result":{"decision":"decline"}}
server->client  {"method":"serverRequest/resolved","params":{"threadId":…,"requestId":1}}
(Enter pressed in the TUI 3 s later: no client frame)
server->client  {"method":"item/commandExecution/requestApproval","id":3,…}
client->server  {"id":3,"result":{"decision":"cancel"}}      <- TUI Esc
```

### PR5 decision: GO, with three plan changes

All four GO criteria held:

1. Command and file-change requests are observable on the relay stream.
2. An answer injected on the TUI's upstream connection is accepted.
3. The TUI overlay closes by itself.
4. A late duplicate is harmless.

The plan changes:

1. **Local-answer cleanup.** When the request is answered anywhere other than
   the phone, expire the phone record on `serverRequest/resolved`
   `{threadId, requestId}`, not on the TUI's response frame: another subscribed
   client may answer first, and resolved covers every answer.
2. **"No" is `cancel`, not `decline`.** It mirrors the TUI, and `decline` is
   missing from `availableDecisions` for command escalations. Offer only
   decisions present in `availableDecisions` when that field exists.
   `acceptForSession`, `acceptWithExecpolicyAmendment` and elicitation `persist`
   stay out, because the phone never offers choices that grant lasting
   permission.
   **Owner decision:** `cancel` interrupts the whole turn, unlike Claude's "No".
   A file change's `decline` lets the turn continue, but the desktop never
   sends it. Parity with the TUI means `cancel`.
3. **Key.** Key pending requests by (relay incarnation, threadId, requestId),
   because ids restart with the app-server process. Injection on the
   TUI's own upstream is enough. Swallowing a late same-id TUI answer is optional
   hygiene, since the server ignores it.

Out of PR5 scope: MCP elicitation, `requestUserInput` and permission profiles
need forms, not Yes/No. `requestUserInput` could map to `form.kind='questions'`
later.

## OpenCode results

| Question | Result |
| --- | --- |
| Child (subagent) permission location | **Only** in `permission(childId)`. `permission(rootId)` is `[]`. `permission.asked.sessionID` = child id. `session.children(root)` lists the child (`parentID` = root) |
| TUI display | Drawn on the **parent (root) route** ("△ Permission required … Allow once · Allow always · Reject"). **Not** drawn on the child route. `api.ui.dialog.open` stays false while it is drawn: the prompt is not a dialog-stack dialog |
| `permission.reply` from the plugin | Takes only `requestID`; no sessionID is needed, even for a child request. Returns 200 `true`. The TUI prompt closed and the command ran |
| Second `reply` | 404 `{"_tag":"PermissionNotFoundError","requestID":…,"message":"Permission request not found: …"}` |
| `question.reply` / `question.reject` | 200 `true`. The TUI question closed and the transcript shows the answer. A second reply or reject → 404 `QuestionNotFoundError` |
| Several pending in one session | Two parallel bash calls produced two requests. `permission(root)` lists them in asked order, and the TUI shows only the first. Replying to the second first worked; the first stayed on screen, was then rejected, and closed. The replies are independent, and nothing is superseded |
| Events | `permission.replied {sessionID, requestID, reply}`, `question.replied {sessionID, requestID, answers}`, `question.rejected {sessionID, requestID}`. Each carries the request's own (child) sessionID |
| Question in a child session | **Not reachable in 1.18.30.** The `general` subagent is offered no `question` (and no `task`) tool, so depth > 1 and child questions cannot occur with the default agents |
| Question UI | Single: numbered options + "Type your own answer"; hints "↑↓ select enter submit esc dismiss". Several questions: tab bar `Toppings  Size  Confirm`, `[ ]` rows for `multiple:true`; hints "⇆ tab ↑↓ select enter toggle esc dismiss" |

Existing gap found: `wmux-chat-tui.mjs` `current()` computes `blocked` from
`permission(routeId)` only. While a child's permission is pending on the parent
route, the pane therefore reads `running`, not `awaiting_input`.

### Child-session policy decision (for PR3)

Record only what the desktop TUI shows, under the session the user is looking
at:

- `decisions.read` for route session R returns R's own requests plus the
  requests of R's direct children (`session.children(R)`, or `permission.list()`
  / `question.list()` filtered by `sessionID ∈ {R} ∪ children(R)`). The pane
  record carries R as its display session and the child id as `nativeSessionId`.
- When the route is itself a child (the TUI draws nothing there), return
  nothing.
- `decisions.reply` checks that the requestID is still in that same set, then
  calls `reply({requestID, reply})` with no sessionID.
- Grandchildren are out of scope: subagents cannot spawn tasks in 1.18.30.
- PR3 should also fold the children's pending requests into `current().phase`.

## Not verified

- A real signed-in Codex model. The fixture provider drives the same
  app-server protocol, but a GPT model's freeform `apply_patch` tool path was
  not exercised: file changes came through `exec_command`.
- Codex `y`, `p` and `a` shortcut keys. Only Enter and Esc were pressed.
- Codex Plan mode: whether `requestUserInput` is sent there without the
  feature flag.
- The TUI overlay closing after an answer from a **different** connection. It
  was measured only for an answer injected on the TUI's own connection. It is
  inferred from `serverRequest/resolved` reaching all subscribers.
- Codex desktop or IDE clients attached to the same account server at the same
  time.
- OpenCode child questions and grandchild sessions: not reachable (see above).
- Several children pending at once, and which one the TUI shows first.
