// Re-export shim. The canonical envelope now lives in
// src/shared/hooks/signal-types.ts so the daemon can import it
// (tsconfig.daemon.json pins rootDir to `src`, which puts this directory out
// of reach). Every existing importer of this path keeps working unchanged.
export * from '../../src/shared/hooks/signal-types';
