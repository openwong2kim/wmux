# Work links

A work link is one record for one piece of delegated work. It ties together
the issue the work came from, the A2A task that carries it, the workspace and
pane doing it, the worktree and branch, the PR, and the decisions it raised.
The Git page ("who acts next" on an issue or PR) and Moa's task cards read the
same records, so both show the same state.

- Contract: `src/shared/workLink.ts` (types, guards, filter, state derivation, all pure)
- Store: `src/main/workLink/workLinkStore.ts`
- Producers: `src/main/workLink/a2aProducer.ts`, `src/main/workLink/decisionLink.ts`
- Renderer read access: `src/main/ipc/handlers/workLink.handler.ts`

## The record

| Field | Meaning |
| --- | --- |
| `id` | Link id (a UUID). |
| `origin` | `issue` (started from an issue on the Git page), `moa` (a Moa delegation) or `manual` (any other A2A send). |
| `issue?` | The `IssueRef` (`src/shared/issueRef.ts`) the work is about. Required when `origin` is `issue`; any link may carry one. |
| `title?` | Task or issue title. Untrusted free text, capped at 256 characters. Render it as text only. |
| `a2aTaskId?` | The A2A task carrying the work. At most one link per task. |
| `a2aState?` | The last A2A state seen for that task. An input to the state derivation. |
| `owner` | `{ workspaceId, paneId? }` of the workspace doing the work (the task's receiver). |
| `requester?` | `{ workspaceId, paneId? }` of the workspace that handed it out (the task's sender). |
| `agent?` | Agent slug of the worker, e.g. `claude`. |
| `worktree?` | `{ path, branch? }`. |
| `pr?` | `PrRef`: `{ host, owner, repo, number, url? }`. |
| `prStatus?` | The last PR status seen (`state`, `checks`, `reviewDecision`, `mergeable`, `observedAt`). An input to the derivation. |
| `state` | `queued`, `running`, `needs-you`, `blocked`, `review`, `done` or `abandoned`. |
| `reason?` | Only on `needs-you` (`decision`, `input-required`) and `blocked` (`task-failed`, `ci-failing`, `conflict`, `changes-requested`). `other` comes from a manual `setState`. |
| `decisionIds` | Ids of the decisions raised about this work, oldest first, at most 32. |
| `createdAt`, `updatedAt` | Epoch milliseconds. |

Issues and PRs are keyed as `host/owner/repo#n`, lowercased (`refKey`, `repoKey`).

### Relations

- One link per A2A task.
- An issue can have many links (1:N). A link has at most one issue.
- A link has at most one PR. Several links can point at the same PR.
- A decision is attached to the link of the task it is about. A decision with
  no task (a release question, say) is attached to nothing.

## State

The store re-derives `state` and `reason` every time an input changes, using
`deriveWorkLinkState`. The first matching rule wins:

1. PR merged: `done`.
2. `abandoned` stays `abandoned`. Only a merged PR changes it.
3. Task canceled: `abandoned`.
4. One of the link's decisions is pending: `needs-you` (`decision`).
5. The task's state:
   - `input-required`: `needs-you` (`input-required`)
   - `submitted`: `queued`
   - `working`: `running`
   - `failed`: `blocked` (`task-failed`)
   - `completed`: the PR's phase. No PR means `done`. A PR whose status nobody
     has read yet means `review`. A PR with failing checks, a conflict or
     requested changes means `blocked` with that reason. A PR closed without
     merging means `abandoned`. Otherwise `review`.
6. No task: a PR decides by its phase. Without one the state stays where it
   is, except that a `needs-you` waiting on a decision that is no longer
   pending falls back to `queued`.

`setState(id, state, reason?)` sets a state by hand. The next derivation
replaces it, with one exception: `abandoned` stays.

Who acts next, for the Git page row:

| State | Who acts |
| --- | --- |
| `queued`, `running`, `blocked` | the agent in `owner` |
| `needs-you` | you |
| `review` | the reviewer (usually you) |
| `done`, `abandoned` | nobody |

## Producers

Only main writes links. Every write is best-effort: a store failure never
blocks or fails the delivery or decision that triggered it.

- **A2A send** (`a2a.task.send` in `a2a.rpc.ts`). A new task becomes a link
  with `owner` set to the resolved receiver (and its pane), `requester` set to
  the sender, `a2aTaskId`, `title` and state `queued`. Replies to an existing
  task create nothing.
- **A2A state.** `a2a.task.update` records the daemon's committed state, or
  the requested state when the renderer accepted the fallback path.
  `a2a.task.cancel` records `canceled` only on a real transition. An
  already-ended task's no-op cancel records nothing. A reply or message that
  reopens an ended task records the reopened state. Background `execute`
  workers (`ClaudeWorker`) bypass the router and record their own
  transitions.
- **Decisions.** `deck_ask_decision({ task_id })` attaches the new decision to
  that task's link when the asking brain's workspace is the link's requester
  or owner. The reply carries `linked: true`, or `linked: false` with
  `linkError: 'unknown_task' | 'not_your_task'`. The decision is raised either
  way. A stale decision that is re-raised without `task_id` gets a new id, and
  that id is kept on the old one's links. Answering a decision (from the Deck
  or by a self-resolve) re-derives its links.

What counts as Moa: a send whose router context carries a commander binding
(`ctx.commanderWorkspace`) is recorded as `origin: 'moa'`. With an HQ
designated (`getHqWorkspaceId()` in `deckHqStore.ts`), only the HQ runs a
brain, so these sends are exactly the HQ's delegations. With no HQ designated,
each workspace's own orchestrator brain counts as that workspace's Moa.

Coming from the two lanes:

- **Git page, "Start work from an issue":** `upsert({ origin: 'issue', issue,
  owner, worktree, agent, ... })`. When the work goes out as an A2A task,
  include its `a2aTaskId` so later task states land on this link instead of
  starting a new one. Upsert matches an existing link by `id`, then by
  `a2aTaskId`.
- **Git page, PR reads:** `upsert({ id, pr, prStatus })` whenever a PR is
  read for a linked branch. `prStatus` feeds the `review`/`blocked`/`done`
  part of the derivation.
- **Fanout:** upsert with the worker's `worktree`, `agent` and task id.

## Consumers

- **Git page.** `list({ repo })`, `list({ issue })` or `list({ pr })` for the
  rows; `state`, `reason` and `owner` give the "who acts next" line.
- **Moa task cards.** `list({ workspaceId })` matches links the workspace owns
  or requested. Each card shows `state`, `pr`, and the decisions in
  `decisionIds`. Read the decisions themselves from the Deck decision store.
  "Waiting on you" is every pending decision. A pending decision whose id is
  on no link belongs to no task.

## API

Main (`getWorkLinkStore()`): `list(filter?)`, `get(id)`, `getByTaskId(taskId)`,
`upsert(fields)`, `setState(id, state, reason?)`, `attachDecision(id,
decisionId)`, `refreshDecision(decisionId)`, `onChange(listener)`. Writes never
throw. They return `null` when the input is invalid or the link is unknown.

Renderer (`window.electronAPI.workLinks`), read-only:

```ts
list(filter?: WorkLinkFilter): Promise<WorkLink[]>   // newest first
get(id: string): Promise<WorkLink | null>
onChanged(cb: (ids: string[]) => void): () => void   // re-read what you show
```

`WorkLinkFilter` is `{ repo?, issue?, pr?, workspaceId?, a2aTaskId?, states? }`.
Main parses it, and a malformed key is dropped, not matched.

There is no pipe RPC or MCP tool for links. Agents reach them only through
the producers above. Exposing them to agents would be a separate public API
change.

## Storage and failure

- `work-links.json` in the wmux data dir (follows `WMUX_DATA_SUFFIX`):
  `{ "version": 1, "links": [...] }`, written atomically. Main is the only
  writer, so the in-memory cache is the truth. Writes run one at a time.
- A file that does not parse loads as an empty store, and a file with the
  wrong shape is quarantined. A bad record is dropped on its own. A failed
  write is logged, the change stays in memory, and the next write persists it.
- At most 500 links. Past that, the oldest `done` or `abandoned` links go first.

## Known gaps

- Tasks the renderer creates without `a2a.task.send` (such as a channel
  mention's auto-response) get no link.
- A decision that is cleared instead of answered (its loop was reset) leaves
  the link `needs-you` until the link's next input changes.
- Nothing writes `prStatus` yet, so a completed task with a PR shows `review`
  until the Git page reads that PR.
