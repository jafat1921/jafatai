import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, isUnauthorized } from '@/lib/api'
import type { AuthConfig, User } from '@/lib/types'
import { qk } from './keys'

// null = known logged out; undefined = still checking
export function useMe() {
  return useQuery<User | null>({
    queryKey: qk.me,
    queryFn: async () => {
      try {
        return await api.auth.me()
      } catch (err) {
        if (isUnauthorized(err)) return null
        throw err
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export function useLogin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) => api.auth.login(email, password),
    onSuccess: (user) => qc.setQueryData(qk.me, user),
  })
}

export function useLogout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.auth.logout(),
    onSettled: () => {
      qc.clear()
      qc.setQueryData(qk.me, null)
    },
  })
}

// contract v38: what the sign-in pages offer. A server without it (older) reads as sign-up closed
export function useAuthConfig() {
  return useQuery<AuthConfig>({
    queryKey: qk.authConfig,
    queryFn: () => api.auth.config().catch(() => ({ signup: 'closed', google: false, verify: true }) as AuthConfig),
    staleTime: 10 * 60_000,
  })
}

export function useSignedInAs() {
  const qc = useQueryClient()
  return (user: User) => qc.setQueryData(qk.me, user)
}
