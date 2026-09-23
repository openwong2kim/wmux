### Added

- **Agents can ask "who needs me?" with `fleet_triage`.** A new MCP tool (full, core and commander profiles) returns the Fleet board as data: Needs you, Running and Idle rows with each agent's status, one line of detail and how long it has been quiet, plus the tab to act on. It is computed by the same selector the Fleet overlay renders, so an agent sees exactly what you see, across every workspace unless one is named. Before, an orchestrator had to poll `pane_list` per workspace or read terminals to find a blocked agent.
