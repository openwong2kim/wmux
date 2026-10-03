// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { SavedSurfaceProfiles } from '../SavedSurfaceProfiles';
import type {
  ProfileApplyAggregateResult,
  ProfilePreviewResult,
  SurfaceProfile,
} from '../../../../../../../shared/tokenUsage/profileTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const initialProfiles: SurfaceProfile[] = [
  {
    id: 'prof-1',
    name: 'Minimal Dev',
    createdAt: 1700000000000,
    providers: {
      claude: {
        knownItemIds: ['claude:plugin::git', 'claude:plugin::bash'],
        disabledItemIds: ['claude:plugin::bash'],
      },
      codex: {
        knownItemIds: ['codex:feature::memories'],
        disabledItemIds: [],
      },
    },
  },
  {
    id: 'prof-2',
    name: 'Full Power',
    createdAt: 1700000100000,
    providers: {
      claude: {
        knownItemIds: ['claude:plugin::git'],
        disabledItemIds: [],
      },
    },
  },
];

describe('SavedSurfaceProfiles UI', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);

    let profilesStore = [...initialProfiles];

    window.electronAPI = {
      tokenUsage: {
        listProfiles: vi.fn(async () => [...profilesStore]),
        saveProfile: vi.fn(async ({ name }) => {
          if (profilesStore.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
            throw new Error('A profile with this name already exists.');
          }
          const newProfile: SurfaceProfile = {
            id: `prof-${Date.now()}`,
            name,
            createdAt: Date.now(),
            providers: {},
          };
          profilesStore.push(newProfile);
          return { ok: true, profile: newProfile };
        }),
        deleteProfile: vi.fn(async (id: string) => {
          profilesStore = profilesStore.filter((p) => p.id !== id);
          return true;
        }),
        previewProfile: vi.fn(async (id: string): Promise<ProfilePreviewResult> => {
          return {
            ok: true,
            missing: { count: 1, firstFewIds: ['claude:plugin::old-item'], ids: ['claude:plugin::old-item'] },
            newItems: 2,
            providers: {
              claude: {
                provider: 'claude',
                edits: [{ path: '/home/.claude/settings.json', summary: 'set bash.enabled = false' }],
                rejected: [],
                requiresNewSession: true,
                missingCount: 1,
                newItemsCount: 2,
              },
            },
          };
        }),
        applyProfile: vi.fn(async (id: string): Promise<ProfileApplyAggregateResult> => {
          return {
            ok: true,
            missing: { count: 0, firstFewIds: [] },
            newItems: 0,
            providers: {
              claude: {
                provider: 'claude',
                ok: true,
                appliedItemIds: ['claude:plugin::bash'],
                backups: ['/home/.claude/settings.json.bak'],
                error: null,
              },
            },
          };
        }),
      } as any,
    } as any;
  });

  afterEach(() => {
    document.body.removeChild(container);
    vi.restoreAllMocks();
  });

  it('renders the list of saved surface profiles with names, dates, and disabled counts', async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(SavedSurfaceProfiles));
    });

    expect(container.textContent).toContain('Saved surface profiles');
    expect(container.textContent).toContain('Minimal Dev');
    expect(container.textContent).toContain('Full Power');

    // Minimal Dev has 1 disabled in Claude and 0 disabled in Codex
    const row1 = container.querySelector('[data-testid="saved-profile-row-prof-1"]');
    expect(row1?.textContent).toContain('Claude: 1 disabled');
    expect(row1?.textContent).toContain('Codex: 0 disabled');

    await act(async () => {
      root.unmount();
    });
  });

  it('executes save flow, adds profile to list, and resets the input', async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(SavedSurfaceProfiles));
    });

    const input = container.querySelector('[data-testid="saved-profile-save-input"]') as HTMLInputElement;
    const saveBtn = container.querySelector('[data-testid="saved-profile-save-btn"]') as HTMLButtonElement;

    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      nativeSetter.call(input, 'Focused Coding');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      saveBtn.click();
    });

    expect(window.electronAPI!.tokenUsage!.saveProfile).toHaveBeenCalledWith({ name: 'Focused Coding' });
    expect(container.textContent).toContain('Focused Coding');
    expect(input.value).toBe('');

    await act(async () => {
      root.unmount();
    });
  });

  it('shows error when saving a duplicate profile name', async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(SavedSurfaceProfiles));
    });

    const input = container.querySelector('[data-testid="saved-profile-save-input"]') as HTMLInputElement;
    const saveBtn = container.querySelector('[data-testid="saved-profile-save-btn"]') as HTMLButtonElement;

    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      nativeSetter.call(input, 'minimal dev'); // case-insensitive match
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await act(async () => {
      saveBtn.click();
    });

    expect(container.textContent).toContain('A profile with this name already exists.');

    await act(async () => {
      root.unmount();
    });
  });

  it('executes preview flow: opens dialog with file edits and rejected/missing/new counts', async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(SavedSurfaceProfiles));
    });

    const previewBtn = container.querySelector('[data-testid="saved-profile-preview-btn-prof-1"]') as HTMLButtonElement;
    await act(async () => {
      previewBtn.click();
    });

    expect(window.electronAPI!.tokenUsage!.previewProfile).toHaveBeenCalledWith('prof-1');
    expect(container.textContent).toContain('Preview profile: Minimal Dev');
    expect(container.textContent).toContain('Missing items');
    expect(container.textContent).toContain('New items since capture');
    expect(container.textContent).toContain('set bash.enabled = false');
    expect(container.textContent).toContain('Rejected: 0 · Missing: 1 · New: 2');

    await act(async () => {
      root.unmount();
    });
  });

  it('executes apply flow: asks confirmation, applies, shows backups, session notice, and reloads list', async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(SavedSurfaceProfiles));
    });

    const applyBtn = container.querySelector('[data-testid="saved-profile-apply-btn-prof-1"]') as HTMLButtonElement;
    await act(async () => {
      applyBtn.click();
    });

    // Confirmation dialog open
    expect(container.textContent).toContain('Are you sure you want to apply profile "Minimal Dev"?');

    const confirmBtn = container.querySelector('[data-testid="saved-profile-confirm-apply-btn"]') as HTMLButtonElement;
    await act(async () => {
      confirmBtn.click();
    });

    expect(window.electronAPI!.tokenUsage!.applyProfile).toHaveBeenCalledWith('prof-1');
    expect(container.textContent).toContain('Takes effect in the next CLI session');
    expect(container.textContent).toContain('/home/.claude/settings.json.bak');

    await act(async () => {
      root.unmount();
    });
  });

  it('executes delete flow: asks confirmation, deletes, and removes from list', async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(SavedSurfaceProfiles));
    });

    expect(container.textContent).toContain('Minimal Dev');

    const deleteBtn = container.querySelector('[data-testid="saved-profile-delete-btn-prof-1"]') as HTMLButtonElement;
    await act(async () => {
      deleteBtn.click();
    });

    expect(container.textContent).toContain('Are you sure you want to delete profile "Minimal Dev"?');

    const confirmDeleteBtn = container.querySelector(
      '[data-testid="saved-profile-confirm-delete-btn"]',
    ) as HTMLButtonElement;
    await act(async () => {
      confirmDeleteBtn.click();
    });

    expect(window.electronAPI!.tokenUsage!.deleteProfile).toHaveBeenCalledWith('prof-1');
    expect(container.textContent).not.toContain('Minimal Dev');
    expect(container.textContent).toContain('Full Power');

    await act(async () => {
      root.unmount();
    });
  });

  it('guards against stale async responses with request id ordering', async () => {
    let resolveFirstPreview!: (val: ProfilePreviewResult) => void;
    let resolveSecondPreview!: (val: ProfilePreviewResult) => void;

    const previewMock = vi.fn((id: string) => {
      if (id === 'prof-1') {
        return new Promise<ProfilePreviewResult>((resolve) => {
          resolveFirstPreview = resolve;
        });
      }
      return new Promise<ProfilePreviewResult>((resolve) => {
        resolveSecondPreview = resolve;
      });
    });

    window.electronAPI!.tokenUsage!.previewProfile = previewMock;

    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(SavedSurfaceProfiles));
    });

    // 1. Click preview for prof-1 (slow request)
    const previewBtn1 = container.querySelector('[data-testid="saved-profile-preview-btn-prof-1"]') as HTMLButtonElement;
    await act(async () => {
      previewBtn1.click();
    });

    // 2. Click preview for prof-2 (fast request)
    const previewBtn2 = container.querySelector('[data-testid="saved-profile-preview-btn-prof-2"]') as HTMLButtonElement;
    await act(async () => {
      previewBtn2.click();
    });

    // 3. Resolve prof-2 first
    await act(async () => {
      resolveSecondPreview({
        ok: true,
        missing: { count: 0, firstFewIds: [] },
        newItems: 99,
        providers: {
          claude: {
            provider: 'claude',
            edits: [{ path: 'fast.json', summary: 'fast edit' }],
            rejected: [],
            requiresNewSession: true,
            missingCount: 0,
            newItemsCount: 99,
          },
        },
      });
    });

    expect(container.textContent).toContain('Preview profile: Full Power');
    expect(container.textContent).toContain('fast edit');

    // 4. Resolve prof-1 late (stale request)
    await act(async () => {
      resolveFirstPreview({
        ok: true,
        missing: { count: 5, firstFewIds: [] },
        newItems: 0,
        providers: {
          claude: {
            provider: 'claude',
            edits: [{ path: 'slow.json', summary: 'STALE SLOW EDIT SHOULD NOT APPEAR' }],
            rejected: [],
            requiresNewSession: true,
            missingCount: 5,
            newItemsCount: 0,
          },
        },
      });
    });

    // Stale slow response must NOT have overwritten prof-2's data!
    expect(container.textContent).not.toContain('STALE SLOW EDIT SHOULD NOT APPEAR');
    expect(container.textContent).toContain('fast edit');

    await act(async () => {
      root.unmount();
    });
  });

  it('invalidates preview request on close and ignores late response when another preview is opened', async () => {
    let resolveFirstPreview!: (val: ProfilePreviewResult) => void;
    let resolveSecondPreview!: (val: ProfilePreviewResult) => void;

    const previewMock = vi.fn((id: string) => {
      if (id === 'prof-1') {
        return new Promise<ProfilePreviewResult>((resolve) => {
          resolveFirstPreview = resolve;
        });
      }
      return new Promise<ProfilePreviewResult>((resolve) => {
        resolveSecondPreview = resolve;
      });
    });

    window.electronAPI!.tokenUsage!.previewProfile = previewMock;

    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(SavedSurfaceProfiles));
    });

    // 1. Open preview for prof-1
    const previewBtn1 = container.querySelector('[data-testid="saved-profile-preview-btn-prof-1"]') as HTMLButtonElement;
    await act(async () => {
      previewBtn1.click();
    });

    expect(container.textContent).toContain('Preview profile: Minimal Dev');
    expect(container.textContent).toContain('Calculating preview changes...');

    // 2. Close preview dialog
    const closeBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Close',
    );
    expect(closeBtn).toBeDefined();
    await act(async () => {
      closeBtn!.click();
    });

    // Modal is closed
    expect(container.textContent).not.toContain('Preview profile: Minimal Dev');

    // 3. Resolve prof-1 late while closed
    await act(async () => {
      resolveFirstPreview({
        ok: true,
        missing: { count: 999, firstFewIds: ['late-item'] },
        newItems: 999,
        providers: {
          claude: {
            provider: 'claude',
            edits: [{ path: 'late.json', summary: 'LATE DATA THAT SHOULD NEVER SHOW' }],
            rejected: [],
            requiresNewSession: true,
            missingCount: 999,
            newItemsCount: 999,
          },
        },
      });
    });

    // 4. Open preview for prof-2
    const previewBtn2 = container.querySelector('[data-testid="saved-profile-preview-btn-prof-2"]') as HTMLButtonElement;
    await act(async () => {
      previewBtn2.click();
    });

    expect(container.textContent).toContain('Preview profile: Full Power');

    // Resolve prof-2
    await act(async () => {
      resolveSecondPreview({
        ok: true,
        missing: { count: 0, firstFewIds: [] },
        newItems: 1,
        providers: {
          claude: {
            provider: 'claude',
            edits: [{ path: 'fresh.json', summary: 'fresh edit' }],
            rejected: [],
            requiresNewSession: true,
            missingCount: 0,
            newItemsCount: 1,
          },
        },
      });
    });

    // Late data from prof-1 never shows
    expect(container.textContent).not.toContain('LATE DATA THAT SHOULD NEVER SHOW');
    expect(container.textContent).not.toContain('999');
    expect(container.textContent).toContain('fresh edit');

    await act(async () => {
      root.unmount();
    });
  });

  it('displays "Already up to date" when apply result has nothingToChange: true', async () => {
    window.electronAPI!.tokenUsage!.applyProfile = vi.fn(async () => ({
      ok: true,
      nothingToChange: true,
      providers: {},
      missing: { count: 0, firstFewIds: [] },
      newItems: 0,
    }));

    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(SavedSurfaceProfiles));
    });

    const applyBtn = container.querySelector('[data-testid="saved-profile-apply-btn-prof-1"]') as HTMLButtonElement;
    await act(async () => {
      applyBtn.click();
    });

    const confirmBtn = container.querySelector('[data-testid="saved-profile-confirm-apply-btn"]') as HTMLButtonElement;
    await act(async () => {
      confirmBtn.click();
    });

    expect(container.textContent).toContain('Already up to date');
    expect(container.textContent).toContain('No changes needed for this profile.');

    await act(async () => {
      root.unmount();
    });
  });
});
