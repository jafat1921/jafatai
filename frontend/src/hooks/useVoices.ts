import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { DesignPreviewRequest, Job, SpeakRequest, SpeakResponse, Voice, VoiceCreate, VoicePatch, VoiceQuery } from '@/lib/types'
import { withInto } from '@/stores/generateInto'
import { qk } from './keys'
import { upsertJob } from './useJobs'
import { upsertMedia } from './useMedia'

export function useVoiceEngines() {
  const q = useQuery({ queryKey: qk.voiceEngines, queryFn: () => api.voices.engines(), staleTime: 5 * 60_000 })
  return { engines: q.data ?? [], loading: q.isPending, error: q.isError ? q.error : null }
}

export function useVoices(q: VoiceQuery = {}) {
  return useQuery({ queryKey: qk.voices(q), queryFn: () => api.voices.list(q) })
}

// every cached list gets the new copy, so a star or a rename shows everywhere at once
function patchLists(qc: QueryClient, voice: Voice | null, removeId?: string) {
  for (const q of qc.getQueryCache().findAll({ queryKey: qk.voiceLists })) {
    qc.setQueryData<Voice[]>(q.queryKey, (old) => {
      if (!old) return old
      if (removeId) return old.filter((v) => v.id !== removeId)
      return voice ? old.map((v) => (v.id === voice.id ? voice : v)) : old
    })
  }
}

export function useCreateVoice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: VoiceCreate) => api.voices.create(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.voiceLists }),
  })
}

export function useUpdateVoice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: VoicePatch }) => api.voices.update(id, patch),
    onSuccess: (voice) => patchLists(qc, voice),
  })
}

export function useDeleteVoice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.voices.remove(id),
    onSuccess: (_r, id) => patchLists(qc, null, id),
  })
}

function adopt(qc: QueryClient, res: SpeakResponse) {
  ;(res.items ?? []).forEach((m) => m?.id && upsertMedia(qc, m))
  ;(res.jobs ?? []).forEach((j) => upsertJob(qc, j))
  qc.invalidateQueries({ queryKey: qk.jobs })
  qc.invalidateQueries({ queryKey: qk.dashboard })
}

export function useSpeak() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: SpeakRequest) => api.audio.speak(withInto('audio', body)),
    onSuccess: (res) => adopt(qc, res),
  })
}

export function useDesignPreview() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: DesignPreviewRequest) => api.voices.designPreview(body),
    onSuccess: (res) => adopt(qc, res),
  })
}

const POLL_MS = 1000

const textOf = (job: Job) => {
  const r = job.result as { ref_text?: unknown; text?: unknown } | null | undefined
  return typeof r?.ref_text === 'string' ? r.ref_text : typeof r?.text === 'string' ? r.text : null
}

/**
 * POST /voices/{id}/transcribe, then follow the job on the shared jobs list (polled while it runs, in
 * case the event stream is down) and hand back the transcript once it lands.
 */
export function useTranscribeVoice(onText: (text: string) => void) {
  const qc = useQueryClient()
  const [run, setRun] = useState<{ voiceId: string; jobId: string } | null>(null)
  const start = useMutation({
    mutationFn: (voiceId: string) => api.voices.transcribe(voiceId),
    onSuccess: (job, voiceId) => {
      upsertJob(qc, job)
      setRun({ voiceId, jobId: job.id })
    },
  })
  const jobs = useQuery({ queryKey: qk.jobs, queryFn: () => api.jobs.list(), refetchInterval: run ? POLL_MS : false })
  const job = run ? jobs.data?.find((j) => j.id === run.jobId) : undefined
  const settled = job?.status === 'done' || job?.status === 'failed' || job?.status === 'cancelled'
  const handled = useRef<string | null>(null)
  const callback = useRef(onText)
  useEffect(() => {
    callback.current = onText
  })

  useEffect(() => {
    if (!run || !job || !settled || handled.current === job.id) return
    handled.current = job.id
    if (job.status !== 'done') return
    const direct = textOf(job)
    if (direct !== null) {
      callback.current(direct)
      patchVoiceText(qc, run.voiceId, direct)
      return
    }
    // the job only says it finished; the voice itself carries the new ref_text
    api.voices
      .list()
      .then((all) => {
        const v = all.find((x) => x.id === run.voiceId)
        if (v) {
          callback.current(v.ref_text)
          patchLists(qc, v)
        }
      })
      .catch(() => {})
  }, [run, job, settled, qc])

  const working = start.isPending || (!!run && !settled)
  const error = start.error ?? (job?.status === 'failed' ? new Error(job.error || "Couldn't transcribe the clip.") : null)
  return {
    transcribe: (voiceId: string) => {
      handled.current = null
      start.mutate(voiceId)
    },
    working,
    error,
    progress: job?.status === 'running' ? job.progress : null,
  }
}

function patchVoiceText(qc: QueryClient, id: string, text: string) {
  for (const q of qc.getQueryCache().findAll({ queryKey: qk.voiceLists })) {
    qc.setQueryData<Voice[]>(q.queryKey, (old) => old?.map((v) => (v.id === id ? { ...v, ref_text: text } : v)))
  }
}
