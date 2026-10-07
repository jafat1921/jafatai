import { create } from 'zustand'
import { api, ApiError } from '@/lib/api'

// P1 kept hearts in this browser only; P4 moves them to the server and this key is drained once.
const KEY = 'mixai.favourites'

function readLocal(): string[] {
  try {
    const raw = window.localStorage.getItem(KEY)
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

function writeLocal(ids: string[] | null) {
  try {
    if (ids) window.localStorage.setItem(KEY, JSON.stringify(ids))
    else window.localStorage.removeItem(KEY)
  } catch {
    /* private mode: the heart still works for this visit */
  }
}

// the server says "gen:<id>" for project rows; the grid keys every row by its bare id
const bare = (ref: string) => (ref.startsWith('gen:') ? ref.slice(4) : ref)

interface FavState {
  ids: string[]
  // 'server' once /favourites answered; 'local' on an older server without it
  mode: 'pending' | 'server' | 'local'
  toggle: (id: string) => boolean
  sync: () => Promise<void>
}

export const useFavourites = create<FavState>((set, get) => ({
  ids: readLocal(),
  mode: 'pending',
  toggle: (id) => {
    const on = !get().ids.includes(id)
    const before = get().ids
    const ids = on ? [id, ...before].slice(0, 2000) : before.filter((x) => x !== id)
    set({ ids })
    if (get().mode === 'local') writeLocal(ids)
    else
      api.favourites.toggle(id, on).catch(() => {
        // put the heart back the way the server still has it
        set((s) => ({ ids: on ? s.ids.filter((x) => x !== id) : [id, ...s.ids] }))
      })
    return on
  },
  sync: async () => {
    const local = readLocal()
    try {
      const res = local.length ? await api.favourites.import(local) : await api.favourites.list()
      const refs = Array.isArray(res?.refs) ? res.refs : []
      if (local.length) writeLocal(null)
      set({ ids: refs.map(bare), mode: 'server' })
    } catch (e) {
      // an older server: keep the browser-only behaviour rather than losing hearts
      if (e instanceof ApiError && e.status === 404) set({ mode: 'local' })
    }
  },
}))

export const useIsFavourite = (id: string) => useFavourites((s) => s.ids.includes(id))
