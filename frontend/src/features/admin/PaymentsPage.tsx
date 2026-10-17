import { useDeferredValue, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Banknote, ReceiptText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input, fieldClass } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { qk } from '@/hooks/keys'
import { useMe } from '@/hooks/useAuth'
import { api } from '@/lib/api'
import type { PaymentStatus } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Notice } from '@/features/auth/AuthLayout'
import { announce } from '@/stores/ui'
import { AdminPage, PayBadge, linkButton, pkr, rupees, tableWrap, td, th, usePackages, when } from './shared'

const STATUSES: { value: PaymentStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'Every status' },
  { value: 'pending', label: 'Pending' },
  { value: 'paid', label: 'Paid' },
  { value: 'failed', label: 'Failed' },
  { value: 'refunded', label: 'Refunded' },
]

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['admin-payments'] })
  void qc.invalidateQueries({ queryKey: ['admin-subscriptions'] })
  void qc.invalidateQueries({ queryKey: ['admin-users'] })
}

function RecordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient()
  const { data: me } = useMe()
  const packages = usePackages()
  const users = useQuery({ queryKey: qk.adminUsers('', 'active'), queryFn: () => api.admin.users('', 'active'), enabled: open && !!me?.admin })
  const [userId, setUserId] = useState('')
  const [amount, setAmount] = useState('')
  const [pkg, setPkg] = useState('')
  const [status, setStatus] = useState<'pending' | 'paid'>('paid')
  const [gateway, setGateway] = useState('manual')
  const [reference, setReference] = useState('')
  const record = useMutation({
    mutationFn: () =>
      api.admin.recordPayment({ user_id: userId, amount_pkr: Math.round(Number(amount)), package_id: pkg || null, status, gateway: gateway.trim() || 'manual', reference: reference.trim() }),
    onSuccess: (p) => {
      announce(`Payment of ${rupees(p.amount_pkr)} recorded`)
      invalidate(qc)
      onOpenChange(false)
    },
  })
  const ok = !!userId && amount.trim() !== '' && Number(amount) >= 0
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record a payment</DialogTitle>
          <DialogDescription>For money taken outside the studio, such as a bank transfer. With a package, a paid payment puts them on it now.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            if (ok) record.mutate()
          }}
        >
          {record.isError && <Notice>{record.error.message}</Notice>}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pay-user">Who</Label>
            <select id="pay-user" className={cn(fieldClass, 'h-8')} value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Choose a person</option>
              {(users.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.display_name ? `${u.display_name} (${u.email})` : u.email}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pay-amount">Amount (PKR)</Label>
              <Input id="pay-amount" type="number" min={0} step={1} value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pay-status">Status</Label>
              <select id="pay-status" className={cn(fieldClass, 'h-8')} value={status} onChange={(e) => setStatus(e.target.value as 'pending' | 'paid')}>
                <option value="paid">Paid</option>
                <option value="pending">Pending</option>
              </select>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pay-package">For package</Label>
            <select id="pay-package" className={cn(fieldClass, 'h-8')} value={pkg} onChange={(e) => setPkg(e.target.value)}>
              <option value="">None</option>
              {(packages.data ?? [])
                .filter((p) => !p.custom_for_user_id || p.custom_for_user_id === userId)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {pkr(p.price_pkr)}
                  </option>
                ))}
            </select>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pay-gateway">Paid through</Label>
              <Input id="pay-gateway" value={gateway} onChange={(e) => setGateway(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pay-ref">Reference</Label>
              <Input id="pay-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={record.isPending} disabled={!ok}>
              Record payment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function PaymentDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const qc = useQueryClient()
  const pay = useQuery({ queryKey: qk.adminPayment(id ?? ''), queryFn: () => api.admin.payment(id!), enabled: !!id })
  const mark = useMutation({
    mutationFn: (status: 'paid' | 'refunded' | 'failed') => api.admin.markPayment(id!, status),
    onSuccess: (p) => {
      announce(`Payment marked ${p.status}`)
      invalidate(qc)
    },
  })
  const p = pay.data
  return (
    <Sheet
      open={!!id}
      onOpenChange={(o) => {
        if (!o) {
          mark.reset()
          onClose()
        }
      }}
    >
      <SheetContent aria-describedby="pay-drawer-desc">
        <div className="flex h-full flex-col gap-4 overflow-y-auto p-5">
          <div className="pr-8">
            <SheetTitle className="font-display text-title font-semibold">{p ? rupees(p.amount_pkr) : 'Payment'}</SheetTitle>
            <SheetDescription id="pay-drawer-desc" className="break-all text-body text-studio-muted">
              {p?.user_email ?? ''}
            </SheetDescription>
          </div>
          {pay.isError && <Notice>{pay.error.message}</Notice>}
          {p && (
            <>
              <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1.5 text-body">
                <dt className="text-studio-muted">Status</dt>
                <dd>
                  <PayBadge status={p.status} />
                </dd>
                <dt className="text-studio-muted">Package</dt>
                <dd>{p.package_name || '—'}</dd>
                <dt className="text-studio-muted">Paid through</dt>
                <dd>{p.gateway}</dd>
                <dt className="text-studio-muted">Reference</dt>
                <dd className="break-all">{p.reference || '—'}</dd>
                <dt className="text-studio-muted">Made</dt>
                <dd>{when(p.created_at)}</dd>
                <dt className="text-studio-muted">Changed</dt>
                <dd>{when(p.updated_at)}</dd>
                {p.notes && (
                  <>
                    <dt className="text-studio-muted">Notes</dt>
                    <dd className="whitespace-pre-wrap">{p.notes}</dd>
                  </>
                )}
              </dl>
              {mark.isError && <Notice>{mark.error.message}</Notice>}
              <div className="flex flex-wrap gap-2">
                {(p.status === 'pending' || p.status === 'failed') && (
                  <Button variant="primary" size="sm" loading={mark.isPending} onClick={() => mark.mutate('paid')}>
                    Mark paid
                  </Button>
                )}
                {p.status === 'pending' && (
                  <Button variant="secondary" size="sm" onClick={() => mark.mutate('failed')}>
                    Mark failed
                  </Button>
                )}
                {p.status === 'paid' && (
                  <Button variant="secondary" size="sm" loading={mark.isPending} onClick={() => mark.mutate('refunded')}>
                    Mark refunded
                  </Button>
                )}
              </div>
              <section aria-labelledby="pay-raw" className="flex flex-col gap-1.5">
                <h3 id="pay-raw" className="font-display text-panel font-semibold">
                  What the gateway sent
                </h3>
                {p.raw ? (
                  <pre className="max-h-72 overflow-auto rounded-[6px] border border-studio-border bg-studio-raised p-2 font-mono text-small">{JSON.stringify(p.raw, null, 2)}</pre>
                ) : (
                  <p className="text-body text-studio-muted">Nothing: this one was recorded by hand.</p>
                )}
              </section>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

export function PaymentsPage() {
  const { data: me } = useMe()
  const [status, setStatus] = useState<PaymentStatus | 'all'>('all')
  const [gateway, setGateway] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const gw = useDeferredValue(gateway.trim())
  const pays = useQuery({
    queryKey: qk.adminPayments(status, gw),
    queryFn: () => api.admin.payments(status, gw),
    enabled: !!me?.admin,
    placeholderData: (prev) => prev,
  })
  const rows = pays.data ?? []
  return (
    <AdminPage
      id="payments-title"
      title="Payments"
      intro="Every payment, with what came back from where it was paid. Mark them by hand for now."
      actions={
        <Button variant="primary" onClick={() => setRecording(true)}>
          <Banknote aria-hidden />
          Record a payment
        </Button>
      }
    >
      <div role="search" className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pay-filter-status">Show</Label>
          <select id="pay-filter-status" className={cn(fieldClass, 'h-8 pr-7')} value={status} onChange={(e) => setStatus(e.target.value as PaymentStatus | 'all')}>
            {STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pay-filter-gateway">Paid through</Label>
          <Input id="pay-filter-gateway" className="w-40" placeholder="Any" value={gateway} onChange={(e) => setGateway(e.target.value)} />
        </div>
      </div>
      {pays.isError ? (
        <ErrorState title="Couldn't load the payments" error={pays.error} onRetry={() => pays.refetch()} />
      ) : pays.isPending ? (
        <p role="status" className="text-body text-studio-muted">
          Loading…
        </p>
      ) : rows.length === 0 ? (
        <EmptyState icon={<ReceiptText />} title="No payments">
          Nothing matches yet.
        </EmptyState>
      ) : (
        <div className={tableWrap}>
          <table className="w-full min-w-[820px] border-collapse text-left text-body">
            <caption className="sr-only">Payments, {rows.length} shown</caption>
            <thead className="bg-studio-panel text-small text-studio-muted">
              <tr>
                <th scope="col" className={th}>When</th>
                <th scope="col" className={th}>Who</th>
                <th scope="col" className={cn(th, 'text-right')}>Amount</th>
                <th scope="col" className={th}>Package</th>
                <th scope="col" className={th}>Paid through</th>
                <th scope="col" className={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-t border-studio-border">
                  <th scope="row" className={cn(td, 'whitespace-nowrap font-normal')}>
                    <button type="button" className={linkButton} onClick={() => setOpenId(p.id)} aria-label={`Payment of ${rupees(p.amount_pkr)} from ${p.user_email}, ${when(p.created_at)}`}>
                      {when(p.created_at)}
                    </button>
                  </th>
                  <td className={cn(td, 'break-all')}>{p.user_email}</td>
                  <td className={cn(td, 'text-right tabular-nums')}>{rupees(p.amount_pkr)}</td>
                  <td className={td}>{p.package_name || '—'}</td>
                  <td className={td}>{p.gateway}</td>
                  <td className={td}>
                    <PayBadge status={p.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <PaymentDrawer id={openId} onClose={() => setOpenId(null)} />
      <RecordDialog open={recording} onOpenChange={setRecording} />
    </AdminPage>
  )
}
