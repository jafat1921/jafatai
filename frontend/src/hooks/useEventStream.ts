import { useEffect } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { API_BASE } from '@/lib/api'
import type { Generation, Job, MediaDetail, MediaItem, Reel, Shot } from '@/lib/types'
import { jobLabel } from '@/lib/status'
import { qk } from './keys'
import { upsertJob } from './useJobs'
import { upsertGeneration } from './useGenerations'
import { syncAiJob } from './useAi'
import { upsertShot } from './useShots'
import { setReel, syncReelJob } from './useReel'
import { syncQuickJob } from './useQuick'
import { upsertMedia } from './useMedia'
import { useMyJobs, useToasts } from '@/stores/toasts'
import { announce, useUi } from '@/stores/ui'

function parse<T>(e: MessageEvent): T | null {
  try {
    return JSON.parse(e.data) as T
  } catch {
    return null
  }
}

// Storyboard/location jobs create rows the client never saw; refetch them once the job lands.
const STORYBOARD_JOB = /storyboard|shot|location|compile|take|render|beats/

function syncStoryboardJob(qc: QueryClient, job: Job, before: Job | undefined) {
  if (!job.project_id || !STORYBOARD_JOB.test(job.type)) return
  const finished = job.status === 'done' && before?.status !== 'done'
  // the parent storyboard job creates shots as it goes; refresh when its message moves on
  const progressed = job.status === 'running' && before?.message !== job.message && job.type.includes('storyboard')
  if (!finished && !progressed) return
  qc.invalidateQueries({ queryKey: qk.shots(job.project_id) })
  if (finished && job.type.includes('location')) {
    qc.invalidateQueries({ queryKey: qk.locations(job.project_id) })
    qc.invalidateQueries({ queryKey: qk.scenes(job.project_id) })
  }
}

const ENDED = new Set(['done', 'failed', 'cancelled'])

/** A job this tab started has ended: once its whole request is through, one toast. True when it was ours. */
export function notifyMine(qc: QueryClient, job: Job) {
  const mine = useMyJobs.getState()
  if (!mine.jobs[job.id]) return false
  if (!ENDED.has(job.status)) return true
  const settled = mine.settle(job.id, qc.getQueryData<Job[]>(qk.jobs) ?? [job])
  if (!settled) return true
  const { group, failed, total } = settled
  useToasts.getState().push(
    failed
      ? { tone: 'failed', title: `${failed === total ? 'Failed' : `${failed} of ${total} failed`} — ${group.label}`, detail: job.error ?? undefined, to: group.to }
      : { tone: 'done', title: `Finished — ${group.label}`, to: group.to },
  )
  return true
}

// One stream per tab. EventSource reconnects on its own and resends Last-Event-ID.
export function useEventStream(enabled: boolean) {
  const qc = useQueryClient()
  const setSse = useUi((s) => s.setSse)

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return
    const es = new EventSource(`${API_BASE}/events`, { withCredentials: true })
    setSse('connecting')

    es.onopen = () => {
      setSse('open')
      // anything that happened while we were disconnected
      qc.invalidateQueries({ queryKey: qk.jobs })
    }
    es.onerror = () => setSse(es.readyState === EventSource.CLOSED ? 'closed' : 'connecting')

    es.addEventListener('job', (e) => {
      const job = parse<Job>(e as MessageEvent)
      if (!job) return
      const before = qc.getQueryData<Job[]>(qk.jobs)?.find((j) => j.id === job.id)
      upsertJob(qc, job)
      syncAiJob(qc, job, before)
      syncStoryboardJob(qc, job, before)
      syncReelJob(qc, job, before)
      syncQuickJob(qc, job, before)
      // our own jobs get a toast (itself a live region) instead of the plain announcement
      const ours = before?.status !== job.status && notifyMine(qc, job)
      if (before?.status !== job.status && !ours) {
        if (job.status === 'done') announce(`${jobLabel(job.type)} finished.`)
        else if (job.status === 'failed') announce(`${jobLabel(job.type)} failed${job.error ? `: ${job.error}` : '.'}`)
      }
    })

    es.addEventListener('generation', (e) => {
      const gen = parse<Generation>(e as MessageEvent)
      if (!gen) return
      upsertGeneration(qc, gen)
      qc.setQueryData(qk.generation(gen.id), gen)
      if (gen.target_type === 'media') {
        qc.setQueryData<MediaDetail>(qk.mediaItem(gen.target_id), (old) =>
          old ? { ...old, versions: [gen, ...(old.versions ?? []).filter((v) => v.id !== gen.id)].sort((a, b) => b.version - a.version) } : old,
        )
      }
    })

    // contract-v5: a library item was created, updated, got a new version or finished
    es.addEventListener('media', (e) => {
      const item = parse<MediaItem>(e as MessageEvent)
      if (item?.id) upsertMedia(qc, item)
    })

    es.addEventListener('shot', (e) => {
      const shot = parse<Shot>(e as MessageEvent)
      if (shot) upsertShot(qc, shot)
    })

    // contract-v3: the whole Reel after a sync, a clip change or an assembly status change
    es.addEventListener('reel', (e) => {
      const reel = parse<Reel>(e as MessageEvent)
      if (reel?.project_id) setReel(qc, reel)
    })

    return () => {
      es.close()
      setSse('closed')
    }
  }, [enabled, qc, setSse])
}
