/**
 * Tests for the ClaudeIntegrationSection card.
 *
 * Vitest runs in `node` env without a DOM library (see vitest.config.ts:17),
 * so we mirror the SettingsPanel.firstRunSection pattern:
 *   1. Pure helpers (`deriveState`) tested directly.
 *   2. Constants (`INSTALL_COMMAND`, `STALE_THRESHOLD_MS`) asserted.
 * The component's wiring (useStore subscription, setInterval refresh,
 * clipboardAPI write) is exercised via the live renderer at dogfood time;
 * the data-flow logic is what we lock down here.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  deriveState,
  INSTALL_COMMAND,
  STALE_THRESHOLD_MS,
} from '../ClaudeIntegrationSection';

const NOW = 1_700_000_000_000;
const ONE_HOUR_MS = 60 * 60 * 1000;

const stubFormatter = (ts: number | null): string | null =>
  ts === null ? null : `at ${ts}`;

describe('deriveState — tri-state derivation', () => {
  it('returns "unknown" when count === 0 (initial state)', () => {
    const state = deriveState(0, null, stubFormatter, NOW);
    expect(state).toEqual({ kind: 'unknown' });
  });

  it('returns "unknown" when count > 0 but lastSignalAt is null (defensive)', () => {
    // The runtime path produces a non-null lastSignalAt as soon as count >= 1,
    // but if the field ever desyncs, the card must not crash on rel-formatting.
    const state = deriveState(5, null, stubFormatter, NOW);
    expect(state).toEqual({ kind: 'unknown' });
  });

  it('returns "detected" when lastSignalAt is within STALE_THRESHOLD_MS', () => {
    const lastSignalAt = NOW - 30 * 60 * 1000; // 30 minutes ago
    const state = deriveState(10, lastSignalAt, stubFormatter, NOW);
    expect(state.kind).toBe('detected');
    if (state.kind === 'detected') {
      expect(state.relTime).toBe(`at ${lastSignalAt}`);
    }
  });

  it('returns "stale" when lastSignalAt is older than STALE_THRESHOLD_MS', () => {
    const lastSignalAt = NOW - STALE_THRESHOLD_MS - ONE_HOUR_MS; // 25 hours ago
    const state = deriveState(10, lastSignalAt, stubFormatter, NOW);
    expect(state.kind).toBe('stale');
    if (state.kind === 'stale') {
      expect(state.relTime).toBe(`at ${lastSignalAt}`);
    }
  });

  it('boundary: exactly STALE_THRESHOLD_MS old is still "detected"', () => {
    const lastSignalAt = NOW - STALE_THRESHOLD_MS;
    const state = deriveState(10, lastSignalAt, stubFormatter, NOW);
    expect(state.kind).toBe('detected');
  });

  it('boundary: STALE_THRESHOLD_MS + 1ms old flips to "stale"', () => {
    const lastSignalAt = NOW - STALE_THRESHOLD_MS - 1;
    const state = deriveState(10, lastSignalAt, stubFormatter, NOW);
    expect(state.kind).toBe('stale');
  });

  it('uses the relFormatter result; empty-string fallback when formatter returns null', () => {
    const nullFormatter = vi.fn(() => null);
    const state = deriveState(1, NOW - 1000, nullFormatter, NOW);
    expect(state.kind).toBe('detected');
    if (state.kind === 'detected') {
      expect(state.relTime).toBe('');
    }
    expect(nullFormatter).toHaveBeenCalledWith(NOW - 1000);
  });
});

describe('INSTALL_COMMAND payload', () => {
  it('is a two-line slash-command pair for clipboard copy', () => {
    const lines = INSTALL_COMMAND.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\/plugin marketplace add /);
    expect(lines[1]).toMatch(/^\/plugin install /);
  });

  it('references the openwong2kim/wmux marketplace and the wmux-claude-integration plugin', () => {
    expect(INSTALL_COMMAND).toContain('openwong2kim/wmux');
    expect(INSTALL_COMMAND).toContain('wmux-claude-integration');
  });

  it('plugin install command pins the marketplace via @-suffix', () => {
    // Prevents the install from picking a same-named plugin from a
    // different marketplace if the user has more than one configured.
    expect(INSTALL_COMMAND).toContain('@wmux');
  });
});

describe('STALE_THRESHOLD_MS', () => {
  it('is 24 hours expressed in milliseconds', () => {
    expect(STALE_THRESHOLD_MS).toBe(24 * 60 * 60 * 1000);
  });
});
