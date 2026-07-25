// Re-export shim — the router moved to src/shared/hooks so the daemon can
// own hook-vs-detector arbitration (M1). Main-side importers are unchanged.
export * from '../../shared/hooks/HookSignalRouter';
