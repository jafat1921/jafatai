import { create } from 'zustand'
import { readJSON, writeJSON } from '@/lib/storage'

export type PanelId = 'library' | 'inspector' | 'scenes'

export interface PanelState {
  width: number
  collapsed: boolean
}

export const PANEL_LIMITS: Record<PanelId, { min: number; max: number; default: number; label: string }> = {
  library: { min: 200, max: 400, default: 240, label: 'Library' },
  inspector: { min: 280, max: 520, default: 340, label: 'Inspector' },
  scenes: { min: 180, max: 340, default: 220, label: 'Scenes' },
}

const STORAGE_KEY = 'mixai.workspace.panels.v1'

const defaults: Record<PanelId, PanelState> = {
  library: { width: PANEL_LIMITS.library.default, collapsed: false },
  inspector: { width: PANEL_LIMITS.inspector.default, collapsed: false },
  scenes: { width: PANEL_LIMITS.scenes.default, collapsed: false },
}

const clamp = (id: PanelId, w: number) => Math.round(Math.min(PANEL_LIMITS[id].max, Math.max(PANEL_LIMITS[id].min, w)))

interface WorkspaceState {
  panels: Record<PanelId, PanelState>
  setWidth: (id: PanelId, width: number) => void
  toggleCollapsed: (id: PanelId, collapsed?: boolean) => void
  // selection is per project; keyed so switching projects doesn't leak ids across
  selectedScene: Record<string, string | undefined>
  selectedCharacter: Record<string, string | undefined>
  selectScene: (projectId: string, id: string | undefined) => void
  selectCharacter: (projectId: string, id: string | undefined) => void
}

export const useWorkspace = create<WorkspaceState>((set) => ({
  panels: readJSON(STORAGE_KEY, defaults),
  setWidth: (id, width) => set((s) => ({ panels: { ...s.panels, [id]: { ...s.panels[id], width: clamp(id, width) } } })),
  toggleCollapsed: (id, collapsed) =>
    set((s) => ({
      panels: { ...s.panels, [id]: { ...s.panels[id], collapsed: collapsed ?? !s.panels[id].collapsed } },
    })),
  selectedScene: {},
  selectedCharacter: {},
  selectScene: (projectId, id) => set((s) => ({ selectedScene: { ...s.selectedScene, [projectId]: id } })),
  selectCharacter: (projectId, id) => set((s) => ({ selectedCharacter: { ...s.selectedCharacter, [projectId]: id } })),
}))

let saveTimer: ReturnType<typeof setTimeout> | undefined
useWorkspace.subscribe((state, prev) => {
  if (state.panels === prev.panels) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => writeJSON(STORAGE_KEY, state.panels), 200)
})
