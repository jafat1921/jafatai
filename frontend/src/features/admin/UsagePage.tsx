import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download, Gauge } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { fieldClass } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { qk } from '@/hooks/keys'
import { useMe } from '@/hooks/useAuth'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { AdminPage, minutes, tableWrap, td, th } from './shared'

const RANGES = [7, 30, 90]

const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

export function UsagePage() {
  const { data: me } = useMe()
  const [days, setDays] = useState(30)
  const [who, setWho] = useState('')
  const report = useQuery({
    queryKey: qk.adminUsage(days, who),
    queryFn: () => api.admin.usage(days, who),
    enabled: !!me?.admin,
    placeholderData: (prev) => prev,
  })
  const r = report.data
  const people = r?.top ?? []
  return (
    <AdminPage
      id="usage-title"
      title="GPU usage"
      intro="Minutes the GPUs spent on each person's work, by UTC day."
      actions={
        <a className={buttonVariants({ variant: 'secondary' })} href={api.admin.usageCsvUrl(days, who)} download>
          <Download aria-hidden />
          Download CSV
        </a>
      }
    >
      <div role="search" className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="usage-days">Over</Label>
          <select id="usage-days" className={cn(fieldClass, 'h-8 pr-7')} value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {RANGES.map((n) => (
              <option key={n} value={n}>
                The last {n} days
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="usage-who">Who</Label>
          <select id="usage-who" className={cn(fieldClass, 'h-8 pr-7')} value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">Everyone</option>
            {people.map((p) => (
              <option key={p.user_id ?? 'none'} value={p.user_id ?? ''}>
                {p.display_name || p.email || 'Unknown'}
              </option>
            ))}
          </select>
        </div>
        {r && <p className="pb-1.5 text-body text-studio-muted">{minutes(r.total_min)} in all</p>}
      </div>
      {report.isError ? (
        <ErrorState title="Couldn't load the usage" error={report.error} onRetry={() => report.refetch()} />
      ) : !r?.rows ? (
        <p role="status" className="text-body text-studio-muted">
          Loading…
        </p>
      ) : r.rows.length === 0 ? (
        <EmptyState icon={<Gauge />} title="No GPU work in this range">
          Pick a longer range.
        </EmptyState>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <div className={tableWrap}>
            <table className="w-full min-w-[560px] border-collapse text-left text-body">
              <caption className="sr-only">GPU minutes per person per day</caption>
              <thead className="bg-studio-panel text-small text-studio-muted">
                <tr>
                  <th scope="col" className={th}>Day</th>
                  <th scope="col" className={th}>Who</th>
                  <th scope="col" className={cn(th, 'text-right')}>Minutes</th>
                  <th scope="col" className={cn(th, 'text-right')}>Jobs</th>
                </tr>
              </thead>
              <tbody>
                {r.rows.map((row) => (
                  <tr key={`${row.day}-${row.user_id}`} className="border-t border-studio-border">
                    <th scope="row" className={cn(td, 'whitespace-nowrap font-normal')}>{dayLabel(row.day)}</th>
                    <td className={cn(td, 'break-all')}>{row.display_name || row.email || 'Unknown'}</td>
                    <td className={cn(td, 'text-right tabular-nums')}>{minutes(row.gpu_min)}</td>
                    <td className={cn(td, 'text-right tabular-nums')}>{row.jobs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <section aria-labelledby="usage-top" className="flex flex-col gap-2">
            <h2 id="usage-top" className="font-display text-panel font-semibold">
              Top users
            </h2>
            <ol className="flex flex-col gap-1 text-body">
              {people.map((p, i) => (
                <li key={p.user_id ?? i} className="flex gap-2">
                  <span className="w-5 text-right text-studio-muted">{i + 1}.</span>
                  <span className="min-w-0 flex-1 truncate">{p.display_name || p.email || 'Unknown'}</span>
                  <span className="tabular-nums">{minutes(p.gpu_min)}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </AdminPage>
  )
}
