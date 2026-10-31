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
});
