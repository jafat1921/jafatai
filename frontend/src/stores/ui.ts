import { create } from 'zustand'

type SseState = 'connecting' | 'open' | 'closed'

interface UiState {
  queueOpen: boolean
  inspectorOpen: boolean
  setInspectorOpen: (open: boolean) => void
  setQueueOpen: (open: boolean) => void
  // aria-live text; the counter forces a re-announce of identical messages
  announcement: { text: string; n: number }
  announce: (text: string) => void
  sse: SseState
  setSse: (s: SseState) => void
  // the top bar's right-hand slot; pages portal their actions into it
  actionsSlot: HTMLElement | null
  setActionsSlot: (el: HTMLElement | null) => void
}

export const useUi = create<UiState>((set) => ({
  queueOpen: false,
  setQueueOpen: (queueOpen) => set({ queueOpen }),
  inspectorOpen: false,
  setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
  announcement: { text: '', n: 0 },
  announce: (text) => set((s) => ({ announcement: { text, n: s.announcement.n + 1 } })),
  sse: 'connecting',
  setSse: (sse) => set({ sse }),
  actionsSlot: null,
  setActionsSlot: (actionsSlot) => set({ actionsSlot }),
}))

export const announce = (text: string) => useUi.getState().announce(text)
