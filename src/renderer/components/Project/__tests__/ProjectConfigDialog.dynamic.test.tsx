// @vitest-environment jsdom
//
// ProjectConfigDialog on ui/Dialog: review mode shows every command verbatim
// with Trust as the one primary; Escape closes like Not now; the unattended
// consent is a checkbox that defaults off.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../../utils/projectConfigProbe', () => ({
  probeProjectConfig: vi.fn(async () => undefined),
  decideProjectTrust: vi.fn(async () => undefined),
  applyProjectLayoutFresh: vi.fn(async () => undefined),
}));
vi.mock('../../../utils/projectCommands', () => ({ runProjectCommand: vi.fn(async () => undefined) }));

import { useStore } from '../../../stores';
import { decideProjectTrust } from '../../../utils/projectConfigProbe';
import ProjectConfigDialog from '../ProjectConfigDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const company = {
  name: 'shop team',
  ceo: 0,
  seats: [
    { label: 'ceo', owns: 'Plans', agent: 'claude' as const },
    { label: 'web', owns: 'UI', agent: 'claude' as const },
  ],
};

const config = {
  found: true,
  configPath: '/repo/wmux.json',
  trust: 'untrusted' as const,
  config: {
    commands: [{ id: 'test', title: 'Run tests', command: 'npm test' }],
    layout: { type: 'leaf' as const, command: 'claude', restorePermissionMode: true },
  },
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => useStore.setState({ projectDialogWsId: 'ws-1', projectConfigs: { 'ws-1': config } } as never));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => useStore.setState({ projectDialogWsId: null, projectConfigs: {} } as never));
});

describe('ProjectConfigDialog', () => {
  it('shows the commands verbatim with Trust as the only primary', () => {
    act(() => root.render(createElement(ProjectConfigDialog)));
    const panel = container.querySelector('[data-testid="project-config-dialog"]') as HTMLElement;
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.textContent).toContain('npm test');
    const primaries = panel.querySelectorAll('.ui-btn-primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0].textContent).toBe('Trust');
  });

  it('passes the unattended consent (default off) with the trust decision', () => {
    act(() => root.render(createElement(ProjectConfigDialog)));
    const box = container.querySelector('[role="checkbox"]') as HTMLButtonElement;
    expect(box.getAttribute('aria-checked')).toBe('false');
    act(() => box.click());
    act(() => (container.querySelector('.ui-btn-primary') as HTMLButtonElement).click());
    expect(decideProjectTrust).toHaveBeenCalledWith('ws-1', 'trusted', true);
  });

  it('lists the setup command and the files it copies in the review, verbatim', () => {
    act(() => useStore.setState({
      projectConfigs: { 'ws-1': { ...config, config: { ...config.config, fanout: { setup: 'npm ci && cp x y', copy: ['.env', 'config/local.json'] } } } },
    } as never));
    act(() => root.render(createElement(ProjectConfigDialog)));
    const section = container.querySelector('[data-testid="project-prep-review"]') as HTMLElement;
    expect(section.textContent).toContain('npm ci && cp x y');
    expect(section.textContent).toContain('.env, config/local.json');
    expect(section.textContent).toContain('Only into workspaces you open');
  });

  it('asks to approve the setup and copy settings a legacy approval does not cover, keeping the unattended consent', () => {
    vi.mocked(decideProjectTrust).mockClear();
    act(() => useStore.setState({
      projectConfigs: { 'ws-1': { ...config, trust: 'trusted', prepReviewed: false, unattended: true, config: { ...config.config, fanout: { copy: ['.env'], copyIntoAutomated: true } } } },
    } as never));
    act(() => root.render(createElement(ProjectConfigDialog)));
    expect(container.querySelector('[data-testid="project-prep-review-needed"]')).not.toBeNull();
    const primary = container.querySelector('.ui-btn-primary') as HTMLButtonElement;
    expect(primary.textContent).toBe('Approve setup');
    act(() => primary.click());
    expect(decideProjectTrust).toHaveBeenCalledWith('ws-1', 'trusted', true);
  });

  it('never marks the company reviewed when it approves the setup and copy settings, since it does not show the company', () => {
    vi.mocked(decideProjectTrust).mockClear();
    act(() => useStore.setState({
      projectConfigs: { 'ws-1': { ...config, trust: 'trusted', prepReviewed: false, companyReviewed: true, config: { ...config.config, company, fanout: { setup: 'npm ci' } } } },
    } as never));
    act(() => root.render(createElement(ProjectConfigDialog)));
    act(() => (container.querySelector('.ui-btn-primary') as HTMLButtonElement).click());
    expect(decideProjectTrust).toHaveBeenCalledWith('ws-1', 'trusted', false);
  });

  it('lists the folder\'s company and whether it is approved to start', () => {
    act(() => useStore.setState({ projectConfigs: { 'ws-1': { ...config, config: { ...config.config, company } } } } as never));
    act(() => root.render(createElement(ProjectConfigDialog)));
    const section = container.querySelector('[data-testid="project-company"]') as HTMLElement;
    expect(section.textContent).toContain('shop team');
    expect(section.textContent).toContain('2 seats');
    expect(section.textContent).toContain('Reviewed on its first start from the + menu');

    act(() => useStore.setState({ projectConfigs: { 'ws-1': { ...config, trust: 'trusted', companyReviewed: true, config: { ...config.config, company } } } } as never));
    expect(container.querySelector('[data-testid="project-company"]')?.textContent).toContain('Approved to start from the + menu');
  });

  it('says when the company in the file cannot be read', () => {
    act(() => useStore.setState({ projectConfigs: { 'ws-1': { ...config, config: { ...config.config, companyInvalid: true } } } } as never));
    act(() => root.render(createElement(ProjectConfigDialog)));
    expect(container.querySelector('[data-testid="project-company"]')?.textContent).toContain('The company in this file can\'t be read.');
  });

  it('closes on Escape without deciding anything', () => {
    vi.mocked(decideProjectTrust).mockClear();
    act(() => root.render(createElement(ProjectConfigDialog)));
    act(() => {
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(useStore.getState().projectDialogWsId).toBeNull();
    expect(decideProjectTrust).not.toHaveBeenCalled();
  });
});
