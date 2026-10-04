import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { Project, ProjectCreate } from '@/lib/types'
import { qk } from './keys'

export function useProjects() {
  return useQuery({ queryKey: qk.projects, queryFn: api.projects.list })
}

export function useProject(id: string | undefined) {
  const qc = useQueryClient()
  return useQuery({
    queryKey: qk.project(id ?? ''),
    queryFn: () => api.projects.get(id!),
    enabled: !!id,
    // the list usually has it already — show that immediately
    initialData: () => qc.getQueryData<Project[]>(qk.projects)?.find((p) => p.id === id),
  })
}

export function useCreateProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: ProjectCreate) => api.projects.create(body),
    onSuccess: (project) => {
      qc.setQueryData(qk.project(project.id), project)
      qc.setQueryData<Project[]>(qk.projects, (old) => (old ? [project, ...old] : [project]))
    },
  })
}
