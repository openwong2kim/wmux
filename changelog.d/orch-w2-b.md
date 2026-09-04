### Added

- **The Deck says what is delegated.** A status panel pinned above the orchestrator conversation lists every open task from the task ledger — title, status, what the worker doing it is up to, its last ledger line and how long it has sat there. It refreshes the moment the ledger moves, collapses to nothing when no task is open, and opens the report rail once while work is outstanding. If the ledger cannot be read at all the panel says so rather than collapsing — "nothing is delegated" and "I cannot tell you what is delegated" are opposite facts.

- **`deck.ledgerGate` has a switch.** The ledger-backed Stop gate — hold the orchestrator's turn while the ledger still lists tasks it delegated, instead of guessing from pane activity — could previously only be turned on by hand-editing `deck-ledger-gate.json`. It is now a toggle in Settings › Agents, labelled experimental, writing the same file the gate reads, so the choice survives a restart.

- **The deck header names the approval deadline.** An approval raised by the orchestrator's own delegation auto-rejects on a timer; with the Claude Code terminal filling the deck, the dialog could sit behind it and the expiry looked like the orchestrator stopping for no reason. The header now counts the deadline down, and turns red for the last ten seconds.

- **Turns say which brain wrote them.** Switching the orchestrator brain mid-session left one log holding turns from two brains that share no transcript and no session. Each turn now carries a short tag for the brain that produced it, and a labelled break separates the runs. Turns from before this change show no tag rather than a guessed one.
