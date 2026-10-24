import { Navigate, Outlet } from 'react-router'
import { useMe } from '@/hooks/useAuth'

/** Admins and the surgeons an admin has let in; anyone else goes home (the server answers them 404 anyway). */
export function ImplantLayout() {
  const { data: me } = useMe()
  if (me && !(me.admin || me.implant)) return <Navigate to="/" replace />
  return (
    <main data-f6-region tabIndex={-1} className="relative h-full overflow-y-auto focus-visible:outline-none" aria-label="Implant Preview">
      <Outlet />
    </main>
  )
}
