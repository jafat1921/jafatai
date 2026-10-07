import { create } from 'zustand'

// TODO: move to the server once the Library has favourites (P4); until then they live in this browser only.
const KEY = 'mixai.favourites'

function load(): string[] {
  try {
    const raw = window.localStorage.getItem(KEY)
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

interface FavState {
  ids: string[]
  toggle: (id: string) => boolean
}

export const useFavourites = create<FavState>((set, get) => ({
  ids: load(),
  toggle: (id) => {
    const on = !get().ids.includes(id)
    const ids = on ? [id, ...get().ids].slice(0, 2000) : get().ids.filter((x) => x !== id)
    set({ ids })
    try {
      window.localStorage.setItem(KEY, JSON.stringify(ids))
    } catch {
      /* private mode: the heart still works for this visit */
    }
    return on
  },
}))

export const useIsFavourite = (id: string) => useFavourites((s) => s.ids.includes(id))
