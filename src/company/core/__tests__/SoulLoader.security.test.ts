import { describe, expect, it, vi } from 'vitest';
import { fetchSoul, loadSoul, prefetchSouls, writeSoulToFile } from '../SoulLoader';

describe('SoulLoader remote prompt hardening', () => {
  it('does not fetch third-party SOUL prompt content at runtime', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchSoul('security-engineer')).resolves.toBeNull();
    await expect(loadSoul('security-engineer')).resolves.toBeNull();
    await expect(prefetchSouls(['security-engineer', 'frontend-developer'])).resolves.toBe(0);

    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('does not install third-party SOUL content as Claude instructions', async () => {
    const writeFile = vi.fn();
    vi.stubGlobal('window', {
      electronAPI: {
        fs: { writeFile },
      },
    });

    await expect(writeSoulToFile('security-engineer', '/tmp/wmux')).resolves.toBe(false);

    expect(writeFile).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
