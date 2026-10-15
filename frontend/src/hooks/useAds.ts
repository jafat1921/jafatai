import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { adsApi, adsBusy, type Ad, type AdCampaign, type AdCreate, type AdPatch, type AdStyle, type ConceptPatch } from '@/lib/ads'
import type { Job } from '@/lib/types'
import { qk } from './keys'
import { upsertJob } from './useJobs'

const POLL_MS = 2500

export const adKey = (id: string) => ['ads', id] as const
const LIST = ['ads', 'list'] as const

export function useAdList() {
  return useQuery({ queryKey: LIST, queryFn: adsApi.list })
}

export function useAdOptions(kitId?: string | null) {
  return useQuery({ queryKey: ['ads', 'options', kitId ?? ''], queryFn: () => adsApi.options(kitId), staleTime: 5 * 60_000 })
}

export function useAdCampaign(id: string | undefined) {
  return useQuery({
    queryKey: adKey(id ?? ''),
    queryFn: () => adsApi.get(id!),
    enabled: !!id,
    refetchInterval: (q) => (adsBusy(q.state.data) ? POLL_MS : false),
  })
}

function put(qc: QueryClient, c: AdCampaign) {
  qc.setQueryData(adKey(c.id), c)
  qc.invalidateQueries({ queryKey: LIST })
}

function afterJob(qc: QueryClient, id: string, job: Job) {
  upsertJob(qc, job)
  qc.invalidateQueries({ queryKey: qk.jobs })
  qc.invalidateQueries({ queryKey: adKey(id) })
}

export function useCreateAds() {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (body: AdCreate) => adsApi.create(body), onSuccess: (c) => put(qc, c) })
}

export function useDeleteAds() {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (id: string) => adsApi.remove(id), onSuccess: () => qc.invalidateQueries({ queryKey: LIST }) })
}

export function useContinueAds(id: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: () => adsApi.continue(id), onSuccess: (job) => afterJob(qc, id, job) })
}

export function usePatchConcept(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ conceptId, ...body }: ConceptPatch & { conceptId: string }) => adsApi.patchConcept(id, conceptId, body),
    onSuccess: (c) => put(qc, c),
  })
}

export function useRegenerateConcept(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ conceptId, ...body }: { conceptId: string; what: 'copy' | 'photo' | 'layout'; layout?: AdStyle }) =>
      adsApi.regenerate(id, conceptId, body),
    onSuccess: (c) => {
      put(qc, c)
      qc.invalidateQueries({ queryKey: qk.jobs })
    },
  })
}

export function usePatchAd(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ adId, ...body }: AdPatch & { adId: string }) => adsApi.patchAd(id, adId, body),
    onSuccess: (ad: Ad) => {
      qc.setQueryData<AdCampaign>(adKey(id), (old) => (old ? { ...old, ads: old.ads.map((a) => (a.id === ad.id ? ad : a)) } : old))
      qc.invalidateQueries({ queryKey: adKey(id) })
    },
  })
}
