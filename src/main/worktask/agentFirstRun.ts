// The first-run detector moved to src/shared so the daemon's scheduled runs
// can use the same allow-list; this path stays for existing main imports.
export * from '../../shared/agentFirstRun';
