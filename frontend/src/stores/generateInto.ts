import { create } from 'zustand'
import type { MediaKind } from '@/lib/types'

const KEY = 'mixai.generate-into'

function load(): Record<MediaKind, string | null> {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? '{}')
    return { image: typeof v.image === 'string' ? v.image : null, video: typeof v.video === 'string' ? v.video : null }
  } catch {
    return { image: null, video: null }
  }
}

interface IntoState {
  into: Record<MediaKind, string | null>
  set: (kind: MediaKind, folderId: string | null) => void
}

/** "Generate into…": the Library folder new results land in, per kind. Shown as a chip on the dock. */
export const useGenerateInto = create<IntoState>((set, get) => ({
  into: load(),
  set: (kind, folderId) => {
    const into = { ...get().into, [kind]: folderId }
    set({ into })
    try {
      window.localStorage.setItem(KEY, JSON.stringify(into))
    } catch {
      /* fine for this visit */
    }
  },
}))

/** Adds folder_id to a generate request when a folder is picked for that kind. */
export function withInto<B extends object>(kind: MediaKind, body: B): B & { folder_id?: string } {
  const id = useGenerateInto.getState().into[kind]
  return id && !('folder_id' in body) ? { ...body, folder_id: id } : body
}
