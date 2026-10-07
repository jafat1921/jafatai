import { create } from 'zustand'

/** One press of Generate on a create page: what was asked, and which library items it made. */
export interface SessionRequest<S = unknown> {
  id: string
  page: string
  at: string
  prompt: string
  summary: string
  itemIds: string[]
  // the dock's form at the time, for Retry and Reuse settings
  settings: S
}

interface SessionState {
  requests: SessionRequest[]
  add: (r: Omit<SessionRequest, 'id' | 'at'> & { at?: string }) => SessionRequest
}

let seq = 0

// in memory on purpose: the Library is the record, this only groups what happened in this tab
export const useSessions = create<SessionState>((set) => ({
  requests: [],
  add: (r) => {
    const req = { ...r, id: `s${++seq}`, at: r.at ?? new Date().toISOString() }
    set((s) => ({ requests: [req, ...s.requests].slice(0, 200) }))
    return req
  },
}))
