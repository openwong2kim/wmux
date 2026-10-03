// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ProviderQuotaCard } from '../tabs/TokenUsageTab/quota/ProviderQuotaCard';
import type { ProviderQuotaReading } from '../../../../shared/tokenUsage/quotaTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ProviderQuotaCard tokens/message rendering', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('renders value: "~N tokens/message (last M)" when present', async () => {
    const reading: ProviderQuotaReading = {
      quota: {
        provider: 'claude',
        status: 'ok',
        windows: [],
        planLabel: 'max',
        creditsLabel: null,
        capturedAtMs: null,
        fetchedAtMs: Date.now(),
        contextUsage: null,
        avgTokensPerMessage: 450,
        message: null,
      },
      deltas: [],
    };
    // Attach sampleSize and partial
    Object.assign(reading.quota, { sampleSize: 120, partial: false });

    await act(async () => {
      root.render(
        <ProviderQuotaCard
          provider="claude"
          reading={reading}
          onRefresh={() => undefined}
        />,
      );
    });

    const el = container.querySelector('[data-testid="quota-avg-tokens-claude"]');
    expect(el).toBeTruthy();
    expect(el?.textContent).toBe('~450 tokens/message (last 120)');
  });

  it('renders partial: "~N tokens/message (last M) (partial)" when flagged', async () => {
    const reading: ProviderQuotaReading = {
      quota: {
        provider: 'codex',
        status: 'ok',
        windows: [],
        planLabel: 'plus',
        creditsLabel: null,
        capturedAtMs: null,
        fetchedAtMs: Date.now(),
        contextUsage: null,
        avgTokensPerMessage: 310,
        message: null,
      },
      deltas: [],
    };
    Object.assign(reading.quota, { sampleSize: 45, partial: true });

    await act(async () => {
      root.render(
        <ProviderQuotaCard
          provider="codex"
          reading={reading}
          onRefresh={() => undefined}
        />,
      );
    });

    const el = container.querySelector('[data-testid="quota-avg-tokens-codex"]');
    expect(el).toBeTruthy();
    expect(el?.textContent).toBe('~310 tokens/message (last 45) (partial)');
  });

  it('renders nothing when null for claude or codex', async () => {
    const reading: ProviderQuotaReading = {
      quota: {
        provider: 'claude',
        status: 'ok',
        windows: [],
        planLabel: 'pro',
        creditsLabel: null,
        capturedAtMs: null,
        fetchedAtMs: Date.now(),
        contextUsage: null,
        avgTokensPerMessage: null,
        message: null,
      },
      deltas: [],
    };

    await act(async () => {
      root.render(
        <ProviderQuotaCard
          provider="claude"
          reading={reading}
          onRefresh={() => undefined}
        />,
      );
    });

    const el = container.querySelector('[data-testid="quota-avg-tokens-claude"]');
    expect(el).toBeNull();
    expect(container.textContent).not.toContain('tokens/message');
  });

  it('renders "not available for agy" when provider is agy', async () => {
    const reading: ProviderQuotaReading = {
      quota: {
        provider: 'agy',
        status: 'ok',
        windows: [],
        planLabel: null,
        creditsLabel: null,
        capturedAtMs: null,
        fetchedAtMs: Date.now(),
        contextUsage: null,
        avgTokensPerMessage: null,
        message: null,
      },
      deltas: [],
    };

    await act(async () => {
      root.render(
        <ProviderQuotaCard
          provider="agy"
          reading={reading}
          onRefresh={() => undefined}
        />,
      );
    });

    const el = container.querySelector('[data-testid="quota-avg-tokens-agy"]');
    expect(el).toBeTruthy();
    expect(el?.textContent).toBe('not available for agy');
  });

  it('supports direct props for avgTokensPerMessage, sampleSize, and partial', async () => {
    await act(async () => {
      root.render(
        <ProviderQuotaCard
          provider="claude"
          avgTokensPerMessage={800}
          sampleSize={500}
          partial={true}
          onRefresh={() => undefined}
        />,
      );
    });

    const el = container.querySelector('[data-testid="quota-avg-tokens-claude"]');
    expect(el?.textContent).toBe('~800 tokens/message (last 500) (partial)');
  });
});
