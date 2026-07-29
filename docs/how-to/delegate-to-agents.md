# How to hand work to another agent

> **Goal:** get an instruction to an agent that is sitting idle in another pane —
> and know whether it arrived.

This is the delegation contract between an orchestrating agent and the agents it
directs. Read it before you write a fan-out; the failure it describes is silent
on both sides, which is what makes it expensive.

## The one rule

**A channel post is a notification. It does not start an idle agent's turn.**

An agent acts when text lands in its prompt. Exactly three things put it there:

| You send | Reaches an idle agent's prompt? |
|---|---|
| `a2a_task_send` (a.k.a. `send_message`) | **Yes** — pasted as a one-line nudge, unless `silent: true` |
| `channel_post` with a mention carrying `pane_id` | **Yes** — pasted at that pane's next idle moment |
| `channel_post` — anything else, including a mention of a *workspace* | **No** — unread badge only |

The third row is deliberate, not a gap. A mention that names no pane may well be
meant for the human sitting in that workspace, and auto-pasting one into
"whichever agent is running there" is how a message addressed to a person once
ended up in an agent's prompt. So an unpinned mention waits to be pulled
(`channel_unread` → `channel_read`), and the agent decides when to look.

## Why it bites

Post an instruction to a channel and nothing errors. The post succeeds, the
message is there, the mention is valid. The worker never sees it, because a
worker that has finished its task is not reading anything — and from the
outside, an idle worker and a working worker look identical. The sender waits on
a reply that was never triggered. Both sides are behaving correctly.

## Doing it right

**Handing out work → send a task.**

```
a2a_task_send(to: "<workspace>", title: "…", message: "…")
```

**Pinging a specific agent in a channel → pin its pane.**

```
channel_post(channel_id, text: "@w2-1(claude) start step 2", mentions: [
  { workspace_id: "<ws>", member_id: "w2-1(claude)", pane_id: "<paneId>" }
])
```

Get `pane_id` from `a2a_discover` or `pane_list`. The pane must belong to
`workspace_id`: the daemon proves it against the principal registry, and a pin it
cannot prove is refused — the mention still lands as a badge, and the refusal
comes back in `droppedMentions` with reason `pane_not_in_workspace`. That check
is what keeps the pin from being a way to paste text into someone else's pane.

**Always read `droppedMentions` on the result.** A mention of a workspace that is
not a channel member is reported there too (`not_a_member`). It is the only
signal that your ping did not land the way you asked.

## If you are the worker

Follow-up instructions do not arrive by themselves once you go idle — see the
table above. If you expect more work, check `channel_unread` / `a2a_task_query`
before you stop, and post your completion to the mission channel. The sender
cannot tell "done and quiet" from "hung" except by what you say.

Agents spawned by fan-out are told this in their opening prompt
(`WORKER_DELIVERY_PREAMBLE` in `src/main/worktask/FanOutService.ts`).
