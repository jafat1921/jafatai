import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { qk } from './keys'
import type { TemplateType } from '@/lib/types'
import { useJobs } from './useJobs'

export function useTemplates(type: TemplateType) {
  return useQuery({ queryKey: qk.templates(type), queryFn: () => api.templates.list(type), staleTime: 10 * 60_000 })
}

export function useStartTemplate() {
  return useMutation({ mutationFn: (id: string) => api.templates.start(id) })
}

// v31: "Save as template" and the My templates cards; the image list carries them, so it is what refreshes
export function useSaveTemplate() {
  const qc = useQueryClient()
  return useMutation({ mutationFn: api.templates.save, onSuccess: () => qc.invalidateQueries({ queryKey: qk.templates('image') }) })
}

export function useRenameTemplate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => api.templates.rename(id, title),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.templates('image') }),
  })
}

export function useDeleteTemplate() {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (id: string) => api.templates.remove(id), onSuccess: () => qc.invalidateQueries({ queryKey: qk.templates('image') }) })
}

export function useDashboard() {
  return useQuery({ queryKey: qk.dashboard, queryFn: api.dashboard, retry: false })
}

export function useComfyCheck(enabled: boolean) {
  return useQuery({ queryKey: qk.comfyCheck, queryFn: api.system.comfyCheck, enabled, staleTime: 60_000, retry: false })
}

export function useLlmCheck(ping: boolean, enabled = true) {
  return useQuery({
    queryKey: qk.llmCheck(ping),
    queryFn: () => api.system.llmCheck(ping),
    enabled,
    staleTime: 60_000,
    retry: false,
  })
}

export function useRunningCount() {
  const { data } = useJobs()
  const running = data?.filter((j) => j.status === 'running').length ?? 0
  const waiting = data?.filter((j) => j.status === 'queued').length ?? 0
  return { running, waiting }
}
