import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { qk } from './keys'

export function useSystemStatus() {
  return useQuery({
    queryKey: qk.system,
    queryFn: api.system.status,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    retry: 1,
  })
}
