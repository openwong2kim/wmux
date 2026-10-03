// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QuotaSection } from '../tabs/TokenUsageTab/QuotaSection';
import type {
  AgySensorInstallResult,
  AgySensorStatus,
  ProviderQuotaReading,
  QuotaReadResult,
} from '../../../../shared/tokenUsage/quotaTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('QuotaSection UI', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let mockReadQuota: ReturnType<typeof vi.fn>;
  let mockAgySensorStatus: ReturnType<typeof vi.fn>;
  let mockInstallAgySensor: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    mockReadQuota = vi.fn();
    mockAgySensorStatus = vi.fn().mockResolvedValue({
      state: 'installed',
      settingsPath: '/mock/settings.json',
      hasData: true,
      message: null,
    } as AgySensorStatus);
    mockInstallAgySensor = vi.fn().mockResolvedValue({
      ok: true,
      action: 'installed',
      message: null,
      status: {
        state: 'installed',
        settingsPath: '/mock/settings.json',
        hasData: true,
        message: null,
      },
    } as AgySensorInstallResult);

    (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      tokenUsage: {
        readQuota: mockReadQuota,
        agySensorStatus: mockAgySensorStatus,
        installAgySensor: mockInstallAgySensor,
      },
    };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('renders loading state initially while reading quota', async () => {
    let resolveQuota: (val: QuotaReadResult) => void = () => undefined;
    mockReadQuota.mockReturnValue(
      new Promise<QuotaReadResult>((resolve) => {
        resolveQuota = resolve;
      }),
    );

    act(() => {
      root.render(<QuotaSection activeProviders={['claude']} />);
    });

    expect(container.querySelector('[data-testid="quota-update-all"]')?.textContent).toContain('Updating...');
    expect(container.querySelector('[data-testid="quota-loading-claude"]')).toBeTruthy();

    await act(async () => {
      resolveQuota({
        readings: [
          {
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
          },
        ],
      });
    });

    expect(container.querySelector('[data-testid="quota-update-all"]')?.textContent).toBe('Update all');
    expect(container.querySelector('[data-testid="quota-loading-claude"]')).toBeNull();
  });

  it('renders ok state with two windows, progress bars, relative resets, and delta text', async () => {
    const reading: ProviderQuotaReading = {
      quota: {
        provider: 'claude',
        status: 'ok',
        planLabel: 'max',
        creditsLabel: null,
        capturedAtMs: null,
        fetchedAtMs: 1759000000000,
        contextUsage: null,
        avgTokensPerMessage: null,
        message: null,
        windows: [
          {
            id: 'five_hour',
            label: '5h',
            usedPct: 35,
            resetAtMs: Date.now() + 2 * 3600 * 1000 + 15 * 60 * 1000,
            windowMins: 300,
          },
          {
            id: 'weekly',
            label: 'weekly',
            usedPct: 80,
            resetAtMs: Date.now() + 48 * 3600 * 1000,
            windowMins: 10080,
          },
        ],
      },
      deltas: [
        {
          windowId: 'five_hour',
          deltaPct: -12,
          windowReset: false,
          previousCheckedAtMs: new Date('2026-10-01T14:02:00').getTime(),
        },
        {
          windowId: 'weekly',
          deltaPct: null,
          windowReset: true,
          previousCheckedAtMs: 1758000000000,
        },
      ],
    };

    mockReadQuota.mockResolvedValue({ readings: [reading] });

    await act(async () => {
      root.render(<QuotaSection activeProviders={['claude']} />);
    });

    expect(container.textContent).toContain('Claude');
    expect(container.textContent).toContain('max');

    // Windows
    const win5h = container.querySelector('[data-testid="quota-window-five_hour"]');
    expect(win5h).toBeTruthy();
    expect(win5h?.textContent).toContain('5h');
    expect(win5h?.textContent).toContain('35%');
    expect(win5h?.textContent).toContain('-12% since 14:02');
    expect(win5h?.textContent).toContain('resets in 2h 15m');

    const winWeekly = container.querySelector('[data-testid="quota-window-weekly"]');
    expect(winWeekly).toBeTruthy();
    expect(winWeekly?.textContent).toContain('weekly');
    expect(winWeekly?.textContent).toContain('80%');
    expect(winWeekly?.textContent).toContain('window reset');
    expect(winWeekly?.textContent).toContain('resets in 2d');

    // Progress bar attributes
    const progressBars = container.querySelectorAll('[role="progressbar"]');
    expect(progressBars).toHaveLength(2);
    expect(progressBars[0].getAttribute('aria-valuenow')).toBe('35');
    expect(progressBars[1].getAttribute('aria-valuenow')).toBe('80');
  });

  it('renders error state with message when status is not ok', async () => {
    const reading: ProviderQuotaReading = {
      quota: {
        provider: 'codex',
        status: 'error',
        planLabel: null,
        creditsLabel: null,
        capturedAtMs: null,
        fetchedAtMs: Date.now(),
        contextUsage: null,
        avgTokensPerMessage: null,
        message: 'Codex app-server is not running.',
        windows: [],
      },
      deltas: [],
    };

    mockReadQuota.mockResolvedValue({ readings: [reading] });

    await act(async () => {
      root.render(<QuotaSection activeProviders={['codex']} />);
    });

    const msg = container.querySelector('[data-testid="quota-message-codex"]');
    expect(msg?.textContent).toContain('Codex app-server is not running.');
    expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(0);
  });

  it('per-card refresh button calls readQuota for only that provider once', async () => {
    mockReadQuota.mockResolvedValue({
      readings: [
        {
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
        },
        {
          quota: {
            provider: 'codex',
            status: 'ok',
            windows: [],
            planLabel: 'plus',
            creditsLabel: null,
            capturedAtMs: null,
            fetchedAtMs: Date.now(),
            contextUsage: null,
            avgTokensPerMessage: null,
            message: null,
          },
          deltas: [],
        },
      ],
    });

    await act(async () => {
      root.render(<QuotaSection activeProviders={['claude', 'codex']} />);
    });

    // Mount call was with both
    expect(mockReadQuota).toHaveBeenCalledWith({ providers: ['claude', 'codex'] });
    expect(mockReadQuota).toHaveBeenCalledTimes(1);

    // Refresh claude only
    const claudeRefreshBtn = container.querySelector('[data-testid="quota-refresh-claude"]') as HTMLButtonElement;
    expect(claudeRefreshBtn).toBeTruthy();

    await act(async () => {
      claudeRefreshBtn.click();
    });

    expect(mockReadQuota).toHaveBeenCalledTimes(2);
    expect(mockReadQuota).toHaveBeenLastCalledWith({ providers: ['claude'] });
  });

  it('does not re-read quota when an equal provider list is passed again', async () => {
    mockReadQuota.mockResolvedValue({ readings: [] });
    await act(async () => {
      root.render(<QuotaSection activeProviders={['claude', 'codex']} />);
    });
    expect(mockReadQuota).toHaveBeenCalledTimes(1);

    // A bindings change rebuilds the array with the same providers: no new read.
    await act(async () => {
      root.render(<QuotaSection activeProviders={['claude', 'codex']} />);
    });
    expect(mockReadQuota).toHaveBeenCalledTimes(1);

    // A provider set that really changed is read.
    await act(async () => {
      root.render(<QuotaSection activeProviders={['claude']} />);
    });
    expect(mockReadQuota).toHaveBeenCalledTimes(2);
  });

  it('renders Install sensor button for agy when sensor is missing and handles installation', async () => {
    mockAgySensorStatus.mockResolvedValue({
      state: 'missing',
      settingsPath: '/mock/settings.json',
      hasData: false,
      message: 'Antigravity quota sensor is not installed.',
    });

    mockReadQuota.mockResolvedValue({
      readings: [
        {
          quota: {
            provider: 'agy',
            status: 'sensor-missing',
            windows: [],
            planLabel: null,
            creditsLabel: null,
            capturedAtMs: null,
            fetchedAtMs: Date.now(),
            contextUsage: null,
            avgTokensPerMessage: null,
            message: 'Antigravity quota sensor is not installed.',
          },
          deltas: [],
        },
      ],
    });

    await act(async () => {
      root.render(<QuotaSection activeProviders={['agy']} />);
    });

    const installBtn = container.querySelector('[data-testid="agy-install-sensor"]') as HTMLButtonElement;
    expect(installBtn).toBeTruthy();
    expect(installBtn.textContent).toContain('Install sensor');

    await act(async () => {
      installBtn.click();
    });

    expect(mockInstallAgySensor).toHaveBeenCalledOnce();
    // Re-reads quota and sensor status after install
    expect(mockReadQuota).toHaveBeenCalledWith({ providers: ['agy'] });
  });

  it('renders note "No supported agent is bound to a role" and fetches nothing when activeProviders is empty', async () => {
    await act(async () => {
      root.render(<QuotaSection activeProviders={[]} />);
    });

    expect(container.textContent).toContain('No supported agent is bound to a role');
    expect(container.querySelector('[data-testid="token-quota-empty"]')).toBeTruthy();
    expect(mockReadQuota).not.toHaveBeenCalled();
    expect(mockAgySensorStatus).not.toHaveBeenCalled();
    expect(container.querySelectorAll('[data-testid^="quota-card-"]')).toHaveLength(0);
    const updateAllBtn = container.querySelector('[data-testid="quota-update-all"]') as HTMLButtonElement;
    expect(updateAllBtn.disabled).toBe(true);
  });

  it('renders note "No supported agent is bound to a role" and fetches nothing when providers prop is empty array', async () => {
    await act(async () => {
      root.render(<QuotaSection providers={[]} />);
    });

    expect(container.textContent).toContain('No supported agent is bound to a role');
    expect(container.querySelector('[data-testid="token-quota-empty"]')).toBeTruthy();
    expect(mockReadQuota).not.toHaveBeenCalled();
    expect(mockAgySensorStatus).not.toHaveBeenCalled();
  });

  it('falls back to all providers ONLY when neither providers nor activeProviders is passed', async () => {
    mockReadQuota.mockResolvedValue({ readings: [] });

    await act(async () => {
      root.render(<QuotaSection />);
    });

    expect(mockReadQuota).toHaveBeenCalledWith({ providers: ['claude', 'codex', 'agy'] });
  });
});
