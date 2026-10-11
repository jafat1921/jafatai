import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { togglePlay } from '@/features/audio/sharedAudio'
import { api } from '@/lib/api'
import { galleryAsVoice, type GalleryQuery, type GalleryVoice } from '@/lib/gallery'
import type { Voice } from '@/lib/types'
import { announce } from '@/stores/ui'
import { qk } from './keys'
import { useVoices } from './useVoices'

// the catalogue only changes with a deploy
const STALE_MS = 10 * 60_000
const POLL_MS = 2000

export function useGallery(q: GalleryQuery = {}) {
  return useQuery({ queryKey: qk.gallery(q), queryFn: () => api.voices.gallery(q), placeholderData: keepPreviousData, staleTime: STALE_MS })
}

/** The whole gallery, unfiltered: the voice pickers search it on the client. */
export function useGalleryVoices() {
  const q = useGallery()
  return { voices: q.data?.items ?? [], loading: q.isPending }
}

/** Library voices plus every gallery voice (id "gallery:<id>"), for checking whatever the picker chose. */
export function useVoiceChoices(): Voice[] {
  const mine = useVoices().data
  const { voices: gallery } = useGalleryVoices()
  return useMemo(() => [...(mine ?? []), ...gallery.map(galleryAsVoice)], [mine, gallery])
}

export function useAddGalleryVoice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, starred }: { id: string; starred?: boolean }) => api.voices.galleryAdd(id, starred === undefined ? {} : { starred }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.voiceLists })
      qc.invalidateQueries({ queryKey: qk.galleryAll })
    },
  })
}

type SampleState = 'preparing' | 'failed'

/**
 * Play a gallery sample through the shared player. A sample that isn't rendered yet answers 202 with
 * its job; we poll the same URL until it's there, then play it.
 */
export function useGallerySample() {
  const [state, setState] = useState<Record<string, SampleState>>({})
  const ready = useRef(new Map<string, string>())
  const timers = useRef(new Map<string, number>())

  useEffect(() => {
    const t = timers.current
    return () => t.forEach((id) => window.clearTimeout(id))
  }, [])

  const settle = (id: string, next: SampleState | null) =>
    setState((s) => {
      const copy = { ...s }
      if (next) copy[id] = next
      else delete copy[id]
      return copy
    })

  const play = useCallback(async (g: GalleryVoice) => {
    const known = ready.current.get(g.id) ?? (g.sample_ready ? `/api/voices/gallery/${encodeURIComponent(g.id)}/sample` : null)
    if (known) return togglePlay(`gallery:${g.id}`, known, { title: g.name, peaks: false })
    if (timers.current.has(g.id)) return
    let firstJob: string | null = null
    const check = async (): Promise<void> => {
      timers.current.delete(g.id)
      try {
        const res = await api.voices.gallerySample(g.id)
        if (res.ready) {
          ready.current.set(g.id, res.url)
          settle(g.id, null)
          announce(`Sample of ${g.name} ready.`)
          togglePlay(`gallery:${g.id}`, res.url, { title: g.name, peaks: false })
          return
        }
        // a new job means the first one failed; don't keep queueing renders
        if ((firstJob && res.job.id !== firstJob) || res.job.status === 'failed') {
          settle(g.id, 'failed')
          announce(`Couldn't prepare the sample of ${g.name}.`)
          return
        }
        if (!firstJob) {
          firstJob = res.job.id
          settle(g.id, 'preparing')
          announce(`Preparing a sample of ${g.name}…`)
        }
        timers.current.set(g.id, window.setTimeout(check, POLL_MS))
      } catch {
        settle(g.id, 'failed')
      }
    }
    await check()
  }, [])

  return { play, state }
}
