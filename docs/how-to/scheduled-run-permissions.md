# Choose how a scheduled run asks for permission

A scheduled run starts your own agent CLI in a background terminal at the time you pick, usually while nobody is at the desk. Its permission mode decides what happens when the agent wants to act.

| Mode | Agents | What the run does |
|---|---|---|
| Approval | Claude, Codex | The agent asks before acting and the run waits for you. Use it only when you are at your desk. A run still waiting after 15 minutes ends as "no response in time". |
| Scoped | Claude, Codex | Claude: only the tools you list run without asking. Codex: writes are allowed inside the folder's sandbox, with no approval prompts. |
| Auto | Claude | Claude's own auto mode: Claude approves routine actions itself and stops risky ones. wmux tools that act on other panes (fan-out, typing into or opening panes, messaging other agents, the browser) stay off. |
| Bypass | Claude, Codex | Every action runs without asking. |

New schedules start in **Auto** for Claude and **Scoped** for Codex. Saving Auto or Bypass shows a confirmation dialog; the schedule gets that mode only when you confirm.

## When a schedule needs its permission again

A permission is granted for exactly what the schedule runs. If its folder, agent, account, model, effort or prompt changes, the editor asks for the permission again in the same save. If you decline, or the change arrived some other way, the schedule's runs are skipped ("permission needs granting again") until you choose **Grant again** on the schedule. A schedule never falls back to a weaker mode by itself.

## Waiting for a response

"Await timeout" under More options sets how long a run may wait for a human. Left empty, it is 15 minutes in Approval and 60 minutes in the other modes. A run that times out ends and frees its slot, so the next occurrence is not skipped as overlapping.

## Auto mode availability

Auto mode belongs to Claude Code, and whether your account and Claude Code version offer it is up to Claude. wmux starts the run with `--permission-mode auto` and does not check afterwards which mode Claude actually applied. If Claude does not offer auto mode to your account, the run may stop on permission prompts like an Approval run. It then ends after the await timeout, and the run's output shows the prompt it stopped on. Use Scoped or Bypass for such an account.
