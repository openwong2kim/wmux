// #3247: a legacy-mode seed that could not read channels.json must not save
// the empty state it fell back to over the user's file. Kept out of
// ChannelService.test.ts because the log-mode matrix re-runs that suite with
// an event-log seed, where this guard does not apply.
import { describe, it, expect, vi } from 'vitest';
import { ChannelService } from '../ChannelService';
import type { ChannelServiceEmit } from '../ChannelService';
import type { ChannelState } from '../../../shared/channels';

describe('ChannelService seeded from an unreadable channels.json', () => {
  it('refuses to persist changes instead of saving over the file', async () => {
    const empty: ChannelState = { version: 1, channels: [], members: {}, messages: {}, idempotency: {} };
    const writer = {
      saveImmediate: vi.fn((): boolean => true),
      load: vi.fn((): ChannelState => empty),
      loadWithStatus: () => ({ status: 'unreadable' as const, state: empty }),
    };
    const svc = new ChannelService({
      writer: writer as unknown as ConstructorParameters<typeof ChannelService>[0]['writer'],
      companyId: 'co-test',
      emit: vi.fn<ChannelServiceEmit>(),
      now: () => 1_700_000_000_000,
    });
    const created = await svc.create({
      name: 'general',
      visibility: 'public',
      createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
      verifiedWorkspaceId: 'ws-1',
    });
    expect(created.ok).toBe(false);
    expect(writer.saveImmediate).not.toHaveBeenCalled();
  });
});
