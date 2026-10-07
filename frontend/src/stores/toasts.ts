import { create } from 'zustand'
import type { Job } from '@/lib/types'

export interface Toast {
  id: string
  title: string
  detail?: string
  to?: string
  tone: 'done' | 'failed'
}

interface ToastState {
  toasts: Toast[]
  push: (t: Omit<Toast, 'id'>) => void
  dismiss: (id: string) => void
}

let seq = 0

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => set((s) => ({ toasts: [...s.toasts, { ...t, id: `t${++seq}` }].slice(-4) })),
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

/**
 * Jobs this tab started, grouped per request (a batch of four images is one group), so one toast
 * says "Finished" when the whole group is through instead of four.
 */
interface Mine {
  group: string
  label: string
  to: string
}

interface MyJobsState {
  jobs: Record<string, Mine>
  done: string[]
  track: (jobs: (Pick<Job, 'id'> | null | undefined)[], label: string, to?: string) => void
  settle: (jobId: string, all: Job[]) => { group: Mine; failed: number; total: number } | null
}

let groupSeq = 0

export const useMyJobs = create<MyJobsState>((set, get) => ({
  jobs: {},
  done: [],
  track: (jobs, label, to) => {
    const group = `g${++groupSeq}`
    const where = to ?? (typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/')
    const add: Record<string, Mine> = {}
    for (const j of jobs) if (j?.id) add[j.id] = { group, label, to: where }
    if (Object.keys(add).length) set((s) => ({ jobs: { ...s.jobs, ...add } }))
  },
  // called when one of our jobs finished; answers the group once every job in it has ended
  settle: (jobId, all) => {
    const mine = get().jobs[jobId]
    if (!mine || get().done.includes(mine.group)) return null
    const ids = Object.entries(get().jobs)
      .filter(([, m]) => m.group === mine.group)
      .map(([id]) => id)
    const states = ids.map((id) => all.find((j) => j.id === id)?.status)
    if (states.some((s) => s === 'queued' || s === 'running')) return null
    set((s) => ({ done: [...s.done, mine.group] }))
    return { group: mine, failed: states.filter((s) => s === 'failed').length, total: ids.length }
  },
}))

export const trackJobs = (jobs: (Pick<Job, 'id'> | null | undefined)[], label: string, to?: string) => useMyJobs.getState().track(jobs, label, to)
