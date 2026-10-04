import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { Character, Generation, Location, GenerationKind, RegenerateMode, TargetType } from '@/lib/types'
import { qk } from './keys'
import { patchShotsFromGeneration } from './useShots'

export interface GenerationTarget {
  targetType: TargetType
  targetId: string
  kind: GenerationKind
}

export function useGenerations({ targetType, targetId, kind }: GenerationTarget, includeRejected: boolean) {
  return useQuery({
    queryKey: qk.generations(targetType, targetId, kind, includeRejected),
    queryFn: () =>
      api.generations.list({ target_type: targetType, target_id: targetId, kind, include_rejected: includeRejected }),
    enabled: !!targetId,
  })
}

const newestFirst = (a: Generation, b: Generation) => b.version - a.version

/**
 * Merges a generation into every cached list for its target (with and without rejected),
 * mirroring the server's "only one approved per target+kind" rule so the UI doesn't flicker
 * between the mutation response and the SSE event.
 */
export function upsertGeneration(qc: QueryClient, gen: Generation) {
  const queries = qc.getQueryCache().findAll({ queryKey: qk.generationsFor(gen.target_type, gen.target_id, gen.kind) })
  for (const q of queries) {
    const includeRejected = q.queryKey[4] === true
    qc.setQueryData<Generation[]>(q.queryKey, (old) => {
      let list = (old ?? []).filter((g) => g.id !== gen.id)
      if (gen.status === 'approved') {
        list = list.map((g) => (g.status === 'approved' ? { ...g, status: 'ready' as const, approved_at: null } : g))
      }
      if (gen.status !== 'rejected' || includeRejected) list.push(gen)
      return list.sort(newestFirst)
    })
  }

  // characters carry approved_portrait, keep it in sync
  if (gen.target_type === 'character' && gen.kind === 'portrait') {
    qc.setQueriesData<Character[]>({ queryKey: ['characters'] }, (old) =>
      old?.map((c) => {
        if (c.id !== gen.target_id) return c
        if (gen.status === 'approved') return { ...c, approved_portrait: gen }
        if (c.approved_portrait?.id === gen.id) return { ...c, approved_portrait: null }
        return c
      }),
    )
  }

  if (gen.target_type === 'location' && gen.kind === 'establishing') {
    qc.setQueriesData<Location[]>({ queryKey: ['locations'] }, (old) =>
      old?.map((l) => {
        if (l.id !== gen.target_id) return l
        if (gen.status === 'approved') return { ...l, approved_establishing: gen }
        if (l.approved_establishing?.id === gen.id) return { ...l, approved_establishing: null }
        return l
      }),
    )
  }

  patchShotsFromGeneration(qc, gen)
}

export function useGenerationActions() {
  const qc = useQueryClient()
  const onSuccess = (g: Generation) => upsertGeneration(qc, g)

  const create = useMutation({
    mutationFn: (body: { target: GenerationTarget; prompt?: string; params?: Record<string, unknown> }) =>
      api.generations.create({
        target_type: body.target.targetType,
        target_id: body.target.targetId,
        kind: body.target.kind,
        // shot keyframes may go out empty: the server then uses the shot's own prompts
        prompt: body.prompt ?? '',
        params: body.params,
      }),
    onSuccess: (g) => {
      onSuccess(g)
      qc.invalidateQueries({ queryKey: qk.jobs })
    },
  })

  const regenerate = useMutation({
    mutationFn: ({ id, ...body }: { id: string; mode: RegenerateMode; note?: string; prompt?: string }) =>
      api.generations.regenerate(id, body),
    onSuccess: (g) => {
      onSuccess(g)
      qc.invalidateQueries({ queryKey: qk.jobs })
    },
  })

  const approve = useMutation({ mutationFn: api.generations.approve, onSuccess })
  const unapprove = useMutation({ mutationFn: api.generations.unapprove, onSuccess })
  const reject = useMutation({ mutationFn: (id: string) => api.generations.reject(id), onSuccess })
  const restore = useMutation({ mutationFn: api.generations.restore, onSuccess })

  return { create, regenerate, approve, unapprove, reject, restore }
}
