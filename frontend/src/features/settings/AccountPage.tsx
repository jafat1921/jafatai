import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, KeyRound, LogOut, Save } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { qk } from '@/hooks/keys'
import { useMe, useSignedInAs } from '@/hooks/useAuth'
import { api } from '@/lib/api'
import { MIN_PASSWORD, Notice, StrengthHint } from '@/features/auth/AuthLayout'
import { Card } from './SystemChecks'

function ProfileCard() {
  const { data: me } = useMe()
  const signedIn = useSignedInAs()
  const [name, setName] = useState(me?.display_name ?? '')
  const save = useMutation({ mutationFn: () => api.auth.updateMe(name.trim()), onSuccess: signedIn })
  if (!me) return null
  const changed = name.trim() !== me.display_name && !!name.trim()
  return (
    <Card title="Profile">
      <form
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          if (changed) save.mutate()
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="acct-name">Name</Label>
          <Input id="acct-name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="acct-email">Email</Label>
          <Input id="acct-email" value={me.email} readOnly aria-describedby="acct-email-hint" className="bg-studio-panel text-studio-muted" />
          <p id="acct-email-hint" className="flex items-center gap-2 text-small text-studio-muted">
            {me.verified === false ? <Badge tone="warning">Not confirmed yet</Badge> : <Badge tone="success">Confirmed</Badge>}
            The address you sign in with.
          </p>
        </div>
        {save.isError && <Notice>{save.error.message}</Notice>}
        <span aria-live="polite" className="text-small text-studio-success">
          {save.isSuccess && !changed ? 'Saved.' : ''}
        </span>
        <Button type="submit" variant="secondary" className="self-start" disabled={!changed} loading={save.isPending}>
          <Save aria-hidden />
          Save name
        </Button>
      </form>
    </Card>
  )
}

function PasswordCard() {
  const signedIn = useSignedInAs()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [tried, setTried] = useState(false)
  const change = useMutation({
    mutationFn: () => api.auth.changePassword(current, next),
    onSuccess: (user) => {
      signedIn(user)
      setCurrent('')
      setNext('')
      setAgain('')
      setTried(false)
    },
  })
  const mismatch = tried && next !== again
  return (
    <Card title="Password">
      <form
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          setTried(true)
          if (next === again) change.mutate()
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pw-current">Current password</Label>
          <Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pw-new">New password</Label>
          <Input
            id="pw-new"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            aria-describedby="pw-new-hint"
          />
          <StrengthHint password={next} id="pw-new-hint" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pw-again">Type it again</Label>
          <Input
            id="pw-again"
            type="password"
            autoComplete="new-password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
            aria-invalid={mismatch || undefined}
            aria-describedby={mismatch ? 'pw-again-error' : undefined}
          />
          {mismatch && (
            <p id="pw-again-error" role="alert" className="text-small text-studio-danger">
              The two passwords don’t match.
            </p>
          )}
        </div>
        {change.isError && <Notice>{change.error.message}</Notice>}
        {change.isSuccess && <Notice tone="ok">Password changed. Other browsers have been signed out.</Notice>}
        <Button
          type="submit"
          variant="secondary"
          className="self-start"
          loading={change.isPending}
          disabled={!current || next.length < MIN_PASSWORD || !again}
        >
          <KeyRound aria-hidden />
          Change password
        </Button>
      </form>
    </Card>
  )
}

function SessionsCard() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [confirm, setConfirm] = useState(false)
  const out = useMutation({
    mutationFn: () => api.auth.logoutEverywhere(),
    onSuccess: () => {
      qc.clear()
      qc.setQueryData(qk.me, null)
      navigate('/login', { replace: true })
    },
  })
  return (
    <Card title="Signed-in browsers">
      <p className="text-body text-studio-muted">
        Lost a laptop or signed in on a shared computer? This signs out every browser, this one included.
      </p>
      {out.isError && <Notice>{out.error.message}</Notice>}
      <Button variant="secondary" className="self-start" loading={out.isPending} onClick={() => setConfirm(true)}>
        <LogOut aria-hidden />
        Sign out everywhere
      </Button>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Sign out everywhere?"
        description="Every browser signed in to your account, this one included, will need the password again. API tokens keep working."
        confirmLabel="Sign out everywhere"
        onConfirm={() => out.mutate()}
      />
    </Card>
  )
}

export function AccountPage() {
  return (
    <main data-f6-region tabIndex={-1} className="relative h-full overflow-y-auto focus-visible:outline-none" aria-labelledby="account-title">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6 md:px-8">
        <div>
          <Link
            to="/settings"
            className="mb-2 inline-flex items-center gap-1 rounded-[4px] text-small text-studio-muted hover:text-studio-text focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-studio-gold/50"
          >
            <ChevronLeft aria-hidden className="size-3.5" />
            Settings
          </Link>
          <h1 id="account-title" className="font-display text-title font-semibold">
            Account
          </h1>
          <p className="text-body text-studio-muted">Your name, password and signed-in browsers.</p>
        </div>
        <ProfileCard />
        <PasswordCard />
        <SessionsCard />
      </div>
    </main>
  )
}
