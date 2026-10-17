import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { ErrorState } from '@/components/studio/states'
import { qk } from '@/hooks/keys'
import { useMe } from '@/hooks/useAuth'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { AdminPage, minutes, rupees, tableWrap, td, th } from './shared'

function Stat({ label, value, sub, to }: { label: string; value: React.ReactNode; sub?: React.ReactNode; to?: string }) {
  const body = (
    <>
      <p className="text-small text-studio-muted">{label}</p>
      <p className="font-display text-title font-semibold tabular-nums">{value}</p>
      {sub && <p className="text-small text-studio-muted">{sub}</p>}
    </>
  )
  const box = 'flex flex-col gap-0.5 rounded-[8px] border border-studio-border-strong bg-studio-panel p-4 shadow-card'
  return to ? (
    <Link to={to} className={cn(box, 'hover:border-studio-border-hover focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-studio-gold/50')}>
      {body}
    </Link>
  ) : (
    <div className={box}>{body}</div>
  )
}

export function OverviewPage() {
  const { data: me } = useMe()
  const ov = useQuery({ queryKey: qk.adminOverview, queryFn: () => api.admin.overview(), enabled: !!me?.admin, refetchInterval: 30_000 })
  const d = ov.data
  return (
    <AdminPage id="overview-title" title="Overview" intro="Who's here, what they're on, and how busy the GPUs are.">
      {ov.isError ? (
        <ErrorState title="Couldn't load the overview" error={ov.error} onRetry={() => ov.refetch()} />
      ) : !d?.users ? (
        <p role="status" className="text-body text-studio-muted">
          Loading…
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Users" value={d.users.total} sub={`${d.users.new_week} new this week`} to="/admin/users" />
            <Stat label="Active today" value={d.users.active_today} sub="signed in or started work" />
            <Stat label="Paid this month" value={rupees(d.payments_month.paid_pkr)} sub={`${d.payments_month.count} payments · ${d.payments_month.pending} waiting`} to="/admin/payments" />
            <Stat
              label="Queue"
              value={`${d.queue.running} running`}
              sub={`${d.queue.queued} waiting · ${d.workers.live} worker${d.workers.live === 1 ? '' : 's'} up`}
            />
          </div>
          {d.workers.idle_lanes.length > 0 && (
            <p role="status" className="rounded-[6px] border border-studio-warning/40 bg-studio-warning/10 p-2.5 text-body">
              No worker is serving: {d.workers.idle_lanes.join(', ')}. Jobs there wait until one starts.
            </p>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            <section aria-labelledby="ov-subs" className="flex flex-col gap-2">
              <h2 id="ov-subs" className="font-display text-panel font-semibold">
                Active packages
              </h2>
              {d.subscriptions.length === 0 ? (
                <p className="text-body text-studio-muted">Nobody has a package yet; everyone is on Free.</p>
              ) : (
                <div className={tableWrap}>
                  <table className="w-full border-collapse text-left text-body">
                    <caption className="sr-only">People on each package</caption>
                    <thead className="bg-studio-panel text-small text-studio-muted">
                      <tr>
                        <th scope="col" className={th}>Package</th>
                        <th scope="col" className={cn(th, 'text-right')}>People</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.subscriptions.map((s) => (
                        <tr key={s.package_id} className="border-t border-studio-border">
                          <th scope="row" className={cn(td, 'font-medium')}>{s.name}</th>
                          <td className={cn(td, 'text-right tabular-nums')}>{s.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section aria-labelledby="ov-gpu" className="flex flex-col gap-2">
              <h2 id="ov-gpu" className="font-display text-panel font-semibold">
                GPU minutes today
              </h2>
              {d.gpu_today.length === 0 ? (
                <p className="text-body text-studio-muted">No GPU work yet today.</p>
              ) : (
                <div className={tableWrap}>
                  <table className="w-full border-collapse text-left text-body">
                    <caption className="sr-only">GPU minutes today by person</caption>
                    <thead className="bg-studio-panel text-small text-studio-muted">
                      <tr>
                        <th scope="col" className={th}>Who</th>
                        <th scope="col" className={cn(th, 'text-right')}>Minutes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.gpu_today.map((r) => (
                        <tr key={r.user_id} className="border-t border-studio-border">
                          <th scope="row" className={cn(td, 'font-medium')}>{r.display_name || r.email}</th>
                          <td className={cn(td, 'text-right tabular-nums')}>{minutes(r.gpu_min)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </AdminPage>
  )
}
