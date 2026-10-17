import { useDeferredValue, useState } from 'react'
import { Navigate } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MailPlus, Search, UserPlus, Users } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input, fieldClass } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { qk } from '@/hooks/keys'
import { useMe } from '@/hooks/useAuth'
import { api } from '@/lib/api'
import type { AdminUser, AdminUserPatch, AdminUserStatus } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Notice } from '@/features/auth/AuthLayout'
import { announce } from '@/stores/ui'

const STATUSES: { value: AdminUserStatus; label: string }[] = [
  { value: 'all', label: 'Everyone' },
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Switched off' },
  { value: 'unverified', label: 'Not confirmed' },
  { value: 'admin', label: 'Admins' },
]

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Never'

const minutes = (n: number) => `${n.toLocaleString('en-GB', { maximumFractionDigits: 1 })} min`

function usePatchUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: AdminUserPatch }) => api.admin.patchUser(id, body),
    onSuccess: (u) => {
      announce(`${u.display_name || u.email} updated`)
      return qc.invalidateQueries({ queryKey: ['admin-users'] })
    },
  })
}

function AddUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [admin, setAdmin] = useState(false)
  const add = useMutation({
    mutationFn: () => api.admin.createUser({ email: email.trim(), name: name.trim(), admin }),
    onSuccess: (u) => {
      announce(`Invite sent to ${u.email}`)
      void qc.invalidateQueries({ queryKey: ['admin-users'] })
      setEmail('')
      setName('')
      setAdmin(false)
      onOpenChange(false)
    },
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a user</DialogTitle>
          <DialogDescription>They get their own private studio and an email with a link to choose a password.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            add.mutate()
          }}
        >
          {add.isError && <Notice>{add.error.message}</Notice>}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-user-name">Name</Label>
            <Input id="new-user-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-user-email">Email</Label>
            <Input id="new-user-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <label className="flex items-center gap-3 text-body">
            <Switch checked={admin} onCheckedChange={setAdmin} />
            Make them an admin too
          </label>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={add.isPending} disabled={!email.trim()}>
              <MailPlus aria-hidden />
              Send invite
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function UserDrawer({ user, self, onClose }: { user: AdminUser | null; self: boolean; onClose: () => void }) {
  const patch = usePatchUser()
  const reset = useMutation({ mutationFn: (id: string) => api.admin.sendReset(id) })
  const resend = useMutation({ mutationFn: (id: string) => api.admin.resendVerification(id) })
  const done = reset.data?.detail ?? resend.data?.detail
  const failed = reset.error ?? resend.error ?? patch.error
  return (
    <Sheet
      open={!!user}
      onOpenChange={(o) => {
        if (!o) {
          reset.reset()
          resend.reset()
          onClose()
        }
      }}
    >
      <SheetContent aria-describedby="user-drawer-desc">
        {user && (
          <div className="flex h-full flex-col gap-4 overflow-y-auto p-5">
            <div className="pr-8">
              <SheetTitle className="font-display text-title font-semibold">{user.display_name || user.email}</SheetTitle>
              <SheetDescription id="user-drawer-desc" className="break-all text-body text-studio-muted">
                {user.email}
              </SheetDescription>
            </div>
            <dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-1.5 text-body">
              <dt className="text-studio-muted">Joined</dt>
              <dd>{when(user.created_at)}</dd>
              <dt className="text-studio-muted">Last sign-in</dt>
              <dd>{when(user.last_login_at)}</dd>
              <dt className="text-studio-muted">GPU today</dt>
              <dd>{minutes(user.gpu_min_today)}</dd>
              <dt className="text-studio-muted">GPU this month</dt>
              <dd>{minutes(user.gpu_min_month)}</dd>
              <dt className="text-studio-muted">Jobs</dt>
              <dd>{user.jobs}</dd>
              <dt className="text-studio-muted">Live API tokens</dt>
              <dd>{user.tokens}</dd>
              <dt className="text-studio-muted">Email</dt>
              <dd>{user.verified ? 'Confirmed' : 'Not confirmed yet'}</dd>
            </dl>
            {done && <Notice tone="ok">{done}</Notice>}
            {failed && <Notice>{failed.message}</Notice>}
            <div className="flex flex-col gap-2">
              {!user.verified && (
                <Button variant="secondary" className="self-start" loading={resend.isPending} onClick={() => resend.mutate(user.id)}>
                  Send the confirm link again
                </Button>
              )}
              {!user.verified && (
                <Button
                  variant="secondary"
                  className="self-start"
                  loading={patch.isPending}
                  onClick={() => patch.mutate({ id: user.id, body: { verified: true } })}
                >
                  Mark the email as confirmed
                </Button>
              )}
              <Button variant="secondary" className="self-start" disabled={!user.is_active} loading={reset.isPending} onClick={() => reset.mutate(user.id)}>
                Email a password reset link
              </Button>
            </div>
            {self && <p className="text-small text-studio-muted">This is you, so it can’t be switched off or lose admin here.</p>}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

export function UsersPage() {
  const { data: me } = useMe()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<AdminUserStatus>('all')
  const [openId, setOpenId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const query = useDeferredValue(q.trim())
  const users = useQuery({
    queryKey: qk.adminUsers(query, status),
    queryFn: () => api.admin.users(query, status),
    enabled: !!me?.admin,
    placeholderData: (prev) => prev,
  })
  const patch = usePatchUser()

  if (me && !me.admin) return <Navigate to="/" replace />
  const rows = users.data ?? []
  const open = rows.find((u) => u.id === openId) ?? null

  return (
    <main data-f6-region tabIndex={-1} className="relative h-full overflow-y-auto focus-visible:outline-none" aria-labelledby="users-title">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6 md:px-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 id="users-title" className="font-display text-title font-semibold">
              Users
            </h1>
            <p className="text-body text-studio-muted">Everyone with an account, each in a studio of their own.</p>
          </div>
          <Button variant="primary" onClick={() => setAdding(true)}>
            <UserPlus aria-hidden />
            Add a user
          </Button>
        </div>

        <div role="search" className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-56 flex-1 flex-col gap-1.5">
            <Label htmlFor="user-search">Search</Label>
            <div className="relative">
              <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-studio-muted" />
              <Input id="user-search" type="search" placeholder="Name or email" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="user-status">Show</Label>
            <select
              id="user-status"
              className={cn(fieldClass, 'h-8 pr-7')}
              value={status}
              onChange={(e) => setStatus(e.target.value as AdminUserStatus)}
            >
              {STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {patch.isError && <Notice>{patch.error.message}</Notice>}
        {users.isError ? (
          <ErrorState title="Couldn't load the users" error={users.error} onRetry={() => users.refetch()} />
        ) : users.isPending ? (
          <p role="status" className="text-body text-studio-muted">
            Loading users…
          </p>
        ) : rows.length === 0 ? (
          <EmptyState icon={<Users />} title="Nobody matches">
            Try another search, or show everyone.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-[8px] border border-studio-border bg-studio-raised">
            <table className="w-full min-w-[760px] border-collapse text-left text-body">
              <caption className="sr-only">Users, {rows.length} shown</caption>
              <thead className="bg-studio-panel text-small text-studio-muted">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Name</th>
                  <th scope="col" className="px-3 py-2 font-medium">Email</th>
                  <th scope="col" className="px-3 py-2 font-medium">Email confirmed</th>
                  <th scope="col" className="px-3 py-2 font-medium">Active</th>
                  <th scope="col" className="px-3 py-2 font-medium">Admin</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">GPU today</th>
                  <th scope="col" className="px-3 py-2 font-medium">Last sign-in</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => {
                  const self = u.id === me?.id
                  const label = u.display_name || u.email
                  return (
                    <tr key={u.id} className={cn('border-t border-studio-border', !u.is_active && 'text-studio-muted')}>
                      <th scope="row" className="px-3 py-1.5 font-medium">
                        <button
                          type="button"
                          className="rounded-[4px] text-left text-studio-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-studio-gold/50"
                          onClick={() => setOpenId(u.id)}
                          aria-label={`Details for ${label}`}
                        >
                          {u.display_name || '—'}
                        </button>
                        {self && <span className="ml-1.5 text-small text-studio-muted">(you)</span>}
                      </th>
                      <td className="break-all px-3 py-1.5">{u.email}</td>
                      <td className="px-3 py-1.5">
                        {u.verified ? <Badge tone="success">Confirmed</Badge> : <Badge tone="warning">Waiting</Badge>}
                      </td>
                      <td className="px-3 py-1.5">
                        <Switch
                          checked={u.is_active}
                          disabled={self}
                          aria-label={`${label} active`}
                          onCheckedChange={(v) => patch.mutate({ id: u.id, body: { is_active: v } })}
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <Switch
                          checked={u.is_admin}
                          disabled={self}
                          aria-label={`${label} admin`}
                          onCheckedChange={(v) => patch.mutate({ id: u.id, body: { is_admin: v } })}
                        />
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{minutes(u.gpu_min_today)}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap">{when(u.last_login_at)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <UserDrawer user={open} self={open?.id === me?.id} onClose={() => setOpenId(null)} />
      <AddUserDialog open={adding} onOpenChange={setAdding} />
    </main>
  )
}
