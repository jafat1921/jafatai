import { create } from 'zustand'

// Session-only image model pick inside a studio project. The lasting default lives in project.settings.
interface ModelChoiceState {
  imageModel: Record<string, string | undefined>
  setImageModel: (projectId: string, id: string | undefined) => void
}

export const useModelChoice = create<ModelChoiceState>((set) => ({
  imageModel: {},
  setImageModel: (projectId, id) => set((s) => ({ imageModel: { ...s.imageModel, [projectId]: id } })),
}))
