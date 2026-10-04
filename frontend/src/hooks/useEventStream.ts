import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { API_BASE } from '@/lib/api'
import type { Generation, Job } from '@/lib/types'
import { jobLabel } from '@/lib/status'
import { qk } from './keys'
import { upsertJob } from './useJobs'
import { upsertGeneration } from './useGenerations'
import { syncAiJob } from './useAi'
import { announce, useUi } from '@/stores/ui'

function parse<T>(e: MessageEvent): T | null {
  try {
    return JSON.parse(e.data) as T
  } catch {
    return null
  }
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
      if (before?.status !== job.status) {
        if (job.status === 'done') announce(`${jobLabel(job.type)} finished.`)
        else if (job.status === 'failed') announce(`${jobLabel(job.type)} failed${job.error ? `: ${job.error}` : '.'}`)
      }
    })

    es.addEventListener('generation', (e) => {
      const gen = parse<Generation>(e as MessageEvent)
      if (gen) upsertGeneration(qc, gen)
    })

    return () => {
      es.close()
      setSse('closed')
    }
  }, [enabled, qc, setSse])
}
