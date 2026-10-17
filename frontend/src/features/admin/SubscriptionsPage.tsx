import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { fieldClass } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { qk } from '@/hooks/keys'
import { useMe } from '@/hooks/useAuth'
import { api } from '@/lib/api'
import type { SubscriptionFilter } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Notice } from '@/features/auth/AuthLayout'
import { announce } from '@/stores/ui'
import { AdminPage, SubBadge, day, tableWrap, td, th, usePackages } from './shared'

const FILTERS: { value: SubscriptionFilter; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'expiring', label: 'Ending in the next 7 days' },
  { value: 'expired', label: 'Expired' },
  { value: 'pending_payment', label: 'Awaiting payment' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'all', label: 'All' },
]

const SOURCE: Record<string, string> = { admin: 'Admin', demo: 'Demo', payment: 'Payment', signup_default: 'On sign-up' }

export function SubscriptionsPage() {
  const { data: me } = useMe()
  const qc = useQueryClient()
  const [status, setStatus] = useState<SubscriptionFilter>('active')
  const [pkg, setPkg] = useState('')
  const packages = usePackages()
  const subs = useQuery({
    queryKey: qk.adminSubscriptions(status, pkg),
    queryFn: () => api.admin.subscriptions(status, pkg),
    enabled: !!me?.admin,
    placeholderData: (prev) => prev,
  })
  const act = useMutation({
    mutationFn: ({ id, what }: { id: string; what: 'extend' | 'cancel' }) =>
      what === 'extend' ? api.admin.extendSubscription(id, { days: 30 }) : api.admin.cancelSubscription(id),
    onSuccess: (s, { what }) => {
      announce(what === 'extend' ? `${s.user_email}: extended to ${day(s.ends_at)}` : `${s.user_email}: cancelled`)
      void qc.invalidateQueries({ queryKey: ['admin-subscriptions'] })
      void qc.invalidateQueries({ queryKey: ['admin-users'] })
    },
  })
  const rows = subs.data ?? []
  return (
    <AdminPage id="subs-title" title="Subscriptions" intro="Who is on which package, and until when. When one ends, the person drops back to Free.">
      <div role="search" className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sub-status">Show</Label>
          <select id="sub-status" className={cn(fieldClass, 'h-8 pr-7')} value={status} onChange={(e) => setStatus(e.target.value as SubscriptionFilter)}>
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sub-package">Package</Label>
          <select id="sub-package" className={cn(fieldClass, 'h-8 pr-7')} value={pkg} onChange={(e) => setPkg(e.target.value)}>
            <option value="">Any package</option>
            {(packages.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {act.isError && <Notice>{act.error.message}</Notice>}
      {subs.isError ? (
        <ErrorState title="Couldn't load the subscriptions" error={subs.error} onRetry={() => subs.refetch()} />
      ) : subs.isPending ? (
        <p role="status" className="text-body text-studio-muted">
          Loading…
        </p>
      ) : rows.length === 0 ? (
        <EmptyState icon={<CalendarClock />} title="None here">
          Try another filter.
        </EmptyState>
      ) : (
        <div className={tableWrap}>
          <table className="w-full min-w-[820px] border-collapse text-left text-body">
            <caption className="sr-only">Subscriptions, {rows.length} shown</caption>
            <thead className="bg-studio-panel text-small text-studio-muted">
              <tr>
                <th scope="col" className={th}>Who</th>
                <th scope="col" className={th}>Package</th>
                <th scope="col" className={th}>Status</th>
                <th scope="col" className={th}>From</th>
                <th scope="col" className={th}>Until</th>
                <th scope="col" className={th}>Given by</th>
                <th scope="col" className={th}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className="border-t border-studio-border">
                  <th scope="row" className={cn(td, 'break-all font-medium')}>{s.user_email}</th>
                  <td className={td}>{s.package_name}</td>
                  <td className={td}>
                    <SubBadge status={s.status} />
                  </td>
                  <td className={cn(td, 'whitespace-nowrap')}>{day(s.starts_at)}</td>
                  <td className={cn(td, 'whitespace-nowrap')}>{day(s.ends_at, 'Open-ended')}</td>
                  <td className={td}>{SOURCE[s.source] ?? s.source}</td>
                  <td className={cn(td, 'whitespace-nowrap text-right')}>
                    {s.status !== 'pending_payment' && s.source !== 'signup_default' && (
                      <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: s.id, what: 'extend' })} aria-label={`Extend ${s.user_email} by 30 days`}>
                        +30 days
                      </Button>
                    )}
                    {(s.status === 'active' || s.status === 'pending_payment') && (
                      <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: s.id, what: 'cancel' })} aria-label={`Cancel ${s.user_email}'s ${s.package_name}`}>
                        Cancel
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminPage>
  )
}
