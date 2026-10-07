import type { Job, MediaItem } from '@/lib/types'
import { useSessions } from '@/stores/sessions'
import { trackJobs } from '@/stores/toasts'

/** After a successful Generate: one session row for the request, and its jobs for the finished toast. */
export function useRecordRun<S>(page: string) {
  const add = useSessions((s) => s.add)
  return (r: { prompt: string; summary: string; settings: S; items: MediaItem[]; jobs?: (Job | null | undefined)[]; label: string }) => {
    add({ page, prompt: r.prompt, summary: r.summary, settings: r.settings, itemIds: r.items.map((m) => m.id) })
    trackJobs(r.jobs ?? [], r.label)
  }
}
