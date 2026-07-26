import { describe, expect, it } from 'vitest';
import { CHANNELS_EPOCH } from '../../../shared/channels';
import { isDaemonOlder } from '../daemonReplacement';

describe('session location protocol epoch', () => {
  it('replaces a same-version daemon that predates atomic location snapshots', () => {
    expect(CHANNELS_EPOCH).toBeGreaterThan(1);
    expect(isDaemonOlder(
      {
        spawnedByVersion: '1.0.0',
        channelsEpoch: CHANNELS_EPOCH - 1,
      },
      '1.0.0',
      CHANNELS_EPOCH,
    )).toMatchObject({ older: true });
  });
});
