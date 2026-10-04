import { Navigate, Outlet, useLocation } from 'react-router'
import { Loader2 } from 'lucide-react'
import { useMe } from '@/hooks/useAuth'
import { ErrorState } from '@/components/studio/states'

export function RequireAuth() {
  const me = useMe()
  const location = useLocation()

  if (me.isPending) {
    return (
      <div className="flex h-full items-center justify-center" role="status">
        <Loader2 aria-hidden className="size-5 animate-spin text-studio-muted" />
        <span className="sr-only">Checking your session…</span>
      </div>
    )
  }
  if (me.isError) {
    return (
      <div className="mx-auto flex h-full max-w-md items-center px-4">
        <ErrorState title="Can't reach the studio server" error={me.error} onRetry={() => me.refetch()} className="w-full" />
      </div>
    )
  }
  if (!me.data) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  }
  return <Outlet />
}
