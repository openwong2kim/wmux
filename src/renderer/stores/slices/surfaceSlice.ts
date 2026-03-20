import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { Pane, PaneLeaf, Surface, Workspace } from '../../../shared/types';
import { createSurface, generateId } from '../../../shared/types';

export interface SurfaceSlice {
  addSurface: (paneId: string, ptyId: string, shell: string, cwd: string) => void;
  addBrowserSurface: (paneId: string, url?: string) => void;
  addEditorSurface: (paneId: string, filePath: string) => void;
  closeSurface: (paneId: string, surfaceId: string) => void;
  setActiveSurface: (paneId: string, surfaceId: string) => void;
  nextSurface: (paneId: string) => void;
  prevSurface: (paneId: string) => void;
  updateSurfacePtyId: (paneId: string, surfaceId: string, ptyId: string) => void;
  updateSurfaceTitle: (surfaceId: string, title: string) => void;
}

function findLeafPane(root: Pane, id: string): PaneLeaf | null {
  if (root.id === id && root.type === 'leaf') return root;
  if (root.type === 'branch') {
    for (const child of root.children) {
      const found = findLeafPane(child, id);
      if (found) return found;
    }
  }
  return null;
}

export const createSurfaceSlice: StateCreator<StoreState, [['zustand/immer', never]], [], SurfaceSlice> = (set) => ({
  addSurface: (paneId, ptyId, shell, cwd) => set((state: StoreState) => {
    const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
    if (!ws) return;
    const pane = findLeafPane(ws.rootPane, paneId);
    if (!pane) return;
    const surface = createSurface(ptyId, shell, cwd);
    pane.surfaces.push(surface);
    pane.activeSurfaceId = surface.id;
  }),

  addBrowserSurface: (paneId, url) => set((state: StoreState) => {
    const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
    if (!ws) return;
    const pane = findLeafPane(ws.rootPane, paneId);
    if (!pane) return;
    const surface: Surface = {
      id: generateId('surface'),
      ptyId: '',
      title: 'Browser',
      shell: '',
      cwd: '',
      surfaceType: 'browser',
      browserUrl: url || 'https://google.com',
    };
    pane.surfaces.push(surface);
    pane.activeSurfaceId = surface.id;
  }),

  addEditorSurface: (paneId, filePath) => set((state: StoreState) => {
    const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
    if (!ws) return;
    const pane = findLeafPane(ws.rootPane, paneId);
    if (!pane) return;
    // If the same file is already open, switch to that tab
    const existing = pane.surfaces.find((s) => s.surfaceType === 'editor' && s.editorFilePath === filePath);
    if (existing) {
      pane.activeSurfaceId = existing.id;
      return;
    }
    const fileName = filePath.split(/[/\\]/).pop() || filePath;
    const surface: Surface = {
      id: generateId('surface'),
      ptyId: '',
      title: fileName,
      shell: '',
      cwd: '',
      surfaceType: 'editor',
      editorFilePath: filePath,
    };
    pane.surfaces.push(surface);
    pane.activeSurfaceId = surface.id;
  }),

  closeSurface: (paneId, surfaceId) => set((state: StoreState) => {
    const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
    if (!ws) return;
    const pane = findLeafPane(ws.rootPane, paneId);
    if (!pane) return;

    const idx = pane.surfaces.findIndex((s) => s.id === surfaceId);
    if (idx === -1) return;

    pane.surfaces.splice(idx, 1);
    if (pane.activeSurfaceId === surfaceId) {
      pane.activeSurfaceId = pane.surfaces[Math.min(idx, pane.surfaces.length - 1)]?.id || '';
    }
  }),

  setActiveSurface: (paneId, surfaceId) => set((state: StoreState) => {
    const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
    if (!ws) return;
    const pane = findLeafPane(ws.rootPane, paneId);
    if (!pane) return;
    if (pane.surfaces.some((s) => s.id === surfaceId)) {
      pane.activeSurfaceId = surfaceId;
    }
  }),

  nextSurface: (paneId) => set((state: StoreState) => {
    const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
    if (!ws) return;
    const pane = findLeafPane(ws.rootPane, paneId);
    if (!pane || pane.surfaces.length <= 1) return;
    const idx = pane.surfaces.findIndex((s) => s.id === pane.activeSurfaceId);
    pane.activeSurfaceId = pane.surfaces[(idx + 1) % pane.surfaces.length].id;
  }),

  prevSurface: (paneId) => set((state: StoreState) => {
    const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
    if (!ws) return;
    const pane = findLeafPane(ws.rootPane, paneId);
    if (!pane || pane.surfaces.length <= 1) return;
    const idx = pane.surfaces.findIndex((s) => s.id === pane.activeSurfaceId);
    pane.activeSurfaceId = pane.surfaces[(idx - 1 + pane.surfaces.length) % pane.surfaces.length].id;
  }),

  updateSurfacePtyId: (paneId, surfaceId, ptyId) => set((state: StoreState) => {
    const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
    if (!ws) return;
    const pane = findLeafPane(ws.rootPane, paneId);
    if (!pane) return;
    const surface = pane.surfaces.find((s) => s.id === surfaceId);
    if (surface) surface.ptyId = ptyId;
  }),

  updateSurfaceTitle: (surfaceId, title) => set((state: StoreState) => {
    for (const ws of state.workspaces) {
      const updateInPane = (pane: Pane): boolean => {
        if (pane.type === 'leaf') {
          const surface = pane.surfaces.find((s) => s.id === surfaceId);
          if (surface) { surface.title = title; return true; }
          return false;
        }
        return pane.children.some(updateInPane);
      };
      if (updateInPane(ws.rootPane)) return;
    }
  }),
});
