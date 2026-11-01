import { describe, expect, it } from 'vitest';
import {
  BUILTIN_COMPANY_PRESETS,
  companyPresetTree,
  companySeatsError,
  freeSeatLabels,
  seatBrief,
} from '../companyPreset';
import { missingBriefFields } from '../company';
import type { PaneBranch } from '../types';

describe('company presets', () => {
  it('ships built-ins whose seats can be made as they are', () => {
    for (const preset of BUILTIN_COMPANY_PRESETS) expect(companySeatsError(preset.seats, preset.ceo)).toBeNull();
    expect(BUILTIN_COMPANY_PRESETS.find((p) => p.id === 'researcher-devs')?.seats.map((s) => s.label)).toEqual(['ceo', 'researcher', 'dev-1', 'dev-2', 'dev-3']);
  });

  it('refuses seats a company cannot have', () => {
    const seat = (label: string) => ({ label, owns: '' });
    expect(companySeatsError([], 0)).toBe('seat-count');
    expect(companySeatsError([seat('a'), seat('b')], 2)).toBe('ceo');
    expect(companySeatsError([seat('lead dev')], 0)).toBe('label');
    expect(companySeatsError([seat('w1-2')], 0)).toBe('label');
    // Taken, `w1` would become the coordinate-like `w1-2`.
    expect(companySeatsError([seat('w1')], 0)).toBe('label');
    expect(companySeatsError([seat('x'.repeat(61))], 0)).toBe('label');
    expect(companySeatsError([seat('Dev'), seat('dev')], 0)).toBe('duplicate');
  });

  it('puts the CEO on the left and stacks the other seats on the right', () => {
    const one = companyPresetTree(1);
    expect(one.root).toBe(one.leaves[0]);
    const four = companyPresetTree(4);
    const root = four.root as PaneBranch;
    expect(root).toMatchObject({ type: 'branch', direction: 'horizontal', sizes: [50, 50] });
    expect(root.children[0]).toBe(four.leaves[0]);
    expect(root.children[1]).toMatchObject({ type: 'branch', direction: 'vertical' });
    expect((root.children[1] as PaneBranch).children).toEqual(four.leaves.slice(1));
    expect(companyPresetTree(2).root).toMatchObject({ children: [{ type: 'leaf' }, { type: 'leaf' }] });
  });

  it('numbers a seat name another pane already answers to', () => {
    expect(freeSeatLabels(['researcher', 'dev-1', 'dev-2'], ['Researcher', 'researcher-2', 'dev-2']))
      .toEqual(['researcher-3', 'dev-1', 'dev-2-2']);
  });

  it('briefs the CEO on the seats and the brief shape wmux requires, and staff on their seat', () => {
    const seats = [{ label: 'researcher', owns: 'Research' }, { label: 'dev-1', owns: '' }, { label: 'dev-2', owns: 'Windows' }];
    const ceo = seatBrief({ company: 'checkout', mission: 'Ship refunds', standingOrders: 'Report with tests.', seats, ceo: 0, seat: 0 });
    expect(ceo).toContain('You are #researcher, the CEO of the company "checkout"');
    expect(ceo).toContain('Your seats: #dev-1, #dev-2 (owns Windows).');
    expect(ceo).toContain('Do not do a seat\'s work yourself.');
    expect(ceo).toContain('Mission: Ship refunds');
    const shape = JSON.parse(/data: (\{.*?\})\./.exec(ceo)![1].replace(/…/g, 'x'));
    expect(missingBriefFields(shape)).toEqual([]);
    const dev = seatBrief({ company: 'checkout', seats, ceo: 0, seat: 1 });
    expect(dev).toContain('You are #dev-1 in the company "checkout" in wmux. Your CEO is #researcher.');
    expect(dev).not.toContain('You own');
    expect(dev).not.toContain('You run the company');
    expect(dev).toContain('a2a_task_update');
    expect(seatBrief({ company: 'checkout', seats, ceo: 0, seat: 2 })).toContain('You own: Windows.');
  });

  it('tells a seat to report with input-required and the CEO to mark the task done', () => {
    const seats = [{ label: 'ceo', owns: '' }, { label: 'dev-1', owns: '' }];
    const dev = seatBrief({ company: 'checkout', seats, ceo: 0, seat: 1 });
    expect(dev).toContain('status input-required');
    for (const part of ['PR URL', 'head commit', 'what you ran', 'who ran the live check']) expect(dev).toContain(part);
    expect(dev).toContain('#ceo marks it done; you cannot.');
    const ceo = seatBrief({ company: 'checkout', seats, ceo: 0, seat: 0 });
    expect(ceo).toContain('A seat reports finished work with status input-required.');
    expect(ceo).toContain('status completed and evidence. Only you or the owner can.');
    expect(ceo).toContain('wmux checks every PR it names (its current head, required checks and open review threads) and refuses until they pass.');
    expect(dev).not.toContain('wmux checks every PR');
  });

  it('tells the CEO a brief past the PC\'s cap waits for a slot, and the ways out', () => {
    const seats = [{ label: 'ceo', owns: '' }, { label: 'dev-1', owns: '' }];
    const ceo = seatBrief({ company: 'checkout', seats, ceo: 0, seat: 0 });
    expect(ceo).toContain('Only a few seats on this PC work at once');
    expect(ceo).toContain('its receipt says reason "cap" and names the seats holding the slots');
    expect(ceo).toContain('once one of them reports or its task ends');
    expect(ceo).toContain('give the work to a seat on another PC');
    expect(seatBrief({ company: 'checkout', seats, ceo: 0, seat: 1 })).not.toContain('reason "cap"');
  });

  it('tells both sides that a reply on a reported task hands it back, and the CEO that it takes a slot', () => {
    const seats = [{ label: 'ceo', owns: '' }, { label: 'dev-1', owns: '' }];
    const ceo = seatBrief({ company: 'checkout', seats, ceo: 0, seat: 0 });
    expect(ceo).toContain('A reply to a seat\'s report hands the work back and takes a slot too; at the cap it is refused');
    expect(ceo).toContain('reply again once one of them reports, or mark the task done.');
    expect(seatBrief({ company: 'checkout', seats, ceo: 0, seat: 1 }))
      .toContain('A reply from #ceo on a task you reported hands it back to you: do the work and report it again the same way.');
  });
});
