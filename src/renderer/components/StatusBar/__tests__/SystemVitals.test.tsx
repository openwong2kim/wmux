import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SystemStatsSnapshot } from '../../../../shared/systemStats';
import {
  buildSystemVitalsTooltip,
  pressureToneClass,
  SystemVitalsView,
  wslPressurePercent,
} from '../SystemVitals';

const stats: SystemStatsSnapshot = {
  cpuPercent: 38,
  memory: { totalBytes: 32 * 1024 ** 3, usedBytes: 24 * 1024 ** 3, percent: 75 },
  appMemoryBytes: 931 * 1024 ** 2,
  wsl: {
    memory: { totalBytes: 20 * 1024 ** 3, usedBytes: 17.6 * 1024 ** 3, percent: 88 },
  },
};

describe('SystemVitals', () => {
  it('uses neutral below 75%, amber from 75%, and red from 85%', () => {
    expect(pressureToneClass(74)).toContain('text-sub2');
    expect(pressureToneClass(75)).toContain('accent-yellow');
    expect(pressureToneClass(84)).toContain('accent-yellow');
    expect(pressureToneClass(85)).toContain('accent-red');
  });

  it('uses WSL VM memory pressure', () => {
    expect(wslPressurePercent(stats)).toBe(88);
  });

  it('renders a compact titlebar summary', () => {
    const html = renderToStaticMarkup(<SystemVitalsView stats={stats} />);
    expect(html).toContain('CPU 38%');
    expect(html).toContain('RAM 75%');
    expect(html).toContain('WSL 88%');
  });

  it('provides exact resource details on hover', () => {
    const tooltip = buildSystemVitalsTooltip(stats);
    expect(tooltip).toContain('Host RAM: 24.0 GB / 32.0 GB (75%)');
    expect(tooltip).toContain('fmux: 931 MB');
    expect(tooltip).toContain('WSL VM RAM: 17.6 GB / 20.0 GB (88%)');
  });
});
