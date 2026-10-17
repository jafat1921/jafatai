import { useDeferredValue, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ScrollText } from 'lucide-react'
import { Input, fieldClass } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { qk } from '@/hooks/keys'
import { useMe } from '@/hooks/useAuth'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { AdminPage, tableWrap, td, th, when } from './shared'

const AREAS = [
  { value: '', label: 'Everything' },
  { value: 'user', label: 'Users' },
  { value: 'subscription', label: 'Subscriptions' },
  { value: 'demo', label: 'Demos' },
  { value: 'grant', label: 'Grants' },
  { value: 'package', label: 'Packages' },
  { value: 'payment', label: 'Payments' },
]

const ACTION: Record<string, string> = {
  user_create: 'Added a user',
  user_update: 'Changed a user',
  user_send_reset: 'Sent a password reset',
  user_resend_verification: 'Sent the confirm link again',
  subscription_assign: 'Changed a package',
  subscription_extend: 'Extended a package',
  subscription_cancel: 'Cancelled a package',
  demo_start: 'Started a demo',
  grant_add: 'Granted minutes',
  grant_revoke: 'Withdrew a grant',
  package_create: 'Made a package',
  package_update: 'Edited a package',
  package_duplicate: 'Duplicated a package',
  package_archive: 'Archived a package',
  package_restore: 'Restored a package',
  package_custom: 'Made a custom package',
  payment_record: 'Recorded a payment',
  payment_paid: 'Marked a payment paid',
  payment_refunded: 'Marked a payment refunded',
  payment_failed: 'Marked a payment failed',
  mark_api: 'Marked API-made items',
}

const detailText = (d: Record<string, unknown>) =>
  Object.entries(d)
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ')

export function AuditPage() {
  const { data: me } = useMe()
  const [area, setArea] = useState('')
  const [q, setQ] = useState('')
  const who = useDeferredValue(q.trim())
  const log = useQuery({
    queryKey: qk.adminAudit(area, who),
    queryFn: () => api.admin.audit(area, who),
    enabled: !!me?.admin,
    placeholderData: (prev) => prev,
  })
  const rows = log.data ?? []
  return (
    <AdminPage id="audit-title" title="Audit log" intro="Every change an admin made, newest first.">
      <div role="search" className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-area">Show</Label>
          <select id="audit-area" className={cn(fieldClass, 'h-8 pr-7')} value={area} onChange={(e) => setArea(e.target.value)}>
            {AREAS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-who">Admin</Label>
          <Input id="audit-who" type="search" className="w-56" placeholder="Email" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {log.isError ? (
        <ErrorState title="Couldn't load the audit log" error={log.error} onRetry={() => log.refetch()} />
      ) : log.isPending ? (
        <p role="status" className="text-body text-studio-muted">
          Loading…
        </p>
      ) : rows.length === 0 ? (
        <EmptyState icon={<ScrollText />} title="Nothing yet">
          Changes made here show up as they happen.
        </EmptyState>
      ) : (
        <div className={tableWrap}>
          <table className="w-full min-w-[760px] border-collapse text-left text-body">
            <caption className="sr-only">Audit log, {rows.length} shown</caption>
            <thead className="bg-studio-panel text-small text-studio-muted">
              <tr>
                <th scope="col" className={th}>When</th>
                <th scope="col" className={th}>Admin</th>
                <th scope="col" className={th}>What</th>
                <th scope="col" className={th}>Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-studio-border align-top">
                  <th scope="row" className={cn(td, 'whitespace-nowrap font-normal')}>{when(r.created_at)}</th>
                  <td className={cn(td, 'break-all')}>{r.actor_email}</td>
                  <td className={td}>{ACTION[r.action] ?? r.action}</td>
                  <td className={cn(td, 'break-words text-small text-studio-muted')}>{detailText(r.detail) || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminPage>
  )
}
