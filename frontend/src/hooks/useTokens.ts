import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { ApiToken, ApiTokenCreate } from '@/lib/types'
import { qk } from './keys'

export function useTokens() {
  return useQuery<ApiToken[]>({ queryKey: qk.tokens, queryFn: api.tokens.list })
}

export function useCreateToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: ApiTokenCreate) => api.tokens.create(body),
    // refetch rather than cache the response: the list must never hold the secret
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.tokens }),
  })
}

export function useRevokeToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.tokens.revoke(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.tokens }),
  })
}
