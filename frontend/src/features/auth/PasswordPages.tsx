import { useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router'
import { useMutation } from '@tanstack/react-query'
import { KeyRound, Mail } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useMe, useSignedInAs } from '@/hooks/useAuth'
import { ApiError, api } from '@/lib/api'
import { AuthLayout, CARD, LINK, MIN_PASSWORD, Notice, StrengthHint } from './AuthLayout'

const backToSignIn = (
  <Link to="/login" className={LINK}>
    Back to sign in
  </Link>
)

function EmailForm({ submitLabel, onSend, pending }: { submitLabel: string; onSend: (email: string) => void; pending: boolean }) {
  const [email, setEmail] = useState('')
  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        onSend(email.trim())
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" autoComplete="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <Button type="submit" variant="primary" size="lg" loading={pending} disabled={!email.trim()}>
        <Mail aria-hidden />
        {submitLabel}
      </Button>
    </form>
  )
}

export function ForgotPasswordPage() {
  const forgot = useMutation({ mutationFn: (email: string) => api.auth.forgot(email) })
  return (
    <AuthLayout subtitle="Forgotten your password?" footer={backToSignIn}>
      <div className={CARD}>
        {forgot.isSuccess ? (
          // the same words whether or not the address has an account
          <Notice tone="ok">
            If there’s an account for that address, a reset link is on its way. It works for one hour.
          </Notice>
        ) : (
          <>
            <p className="text-body text-studio-muted">Enter your email and we’ll send a link to choose a new password.</p>
            {forgot.isError && <Notice>{forgot.error.message}</Notice>}
            <EmailForm submitLabel="Send reset link" pending={forgot.isPending} onSend={(email) => forgot.mutate(email)} />
          </>
        )}
      </div>
    </AuthLayout>
  )
}

export function ResetPasswordPage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const invite = params.get('invite') === '1'
  const navigate = useNavigate()
  const signedIn = useSignedInAs()
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [tried, setTried] = useState(false)
  const reset = useMutation({
    mutationFn: () => api.auth.reset(token, password),
    onSuccess: (user) => {
      signedIn(user)
      navigate('/', { replace: true })
    },
  })

  const mismatch = tried && again !== password
  const expired = reset.error instanceof ApiError && reset.error.status === 400
  const title = invite ? 'Choose your password' : 'Choose a new password'

  if (!token) {
    return (
      <AuthLayout subtitle={title} footer={backToSignIn}>
        <div className={CARD}>
          <Notice>
            This link is missing its code. <Link to="/forgot-password" className={LINK}>Ask for a new one</Link>.
          </Notice>
        </div>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout subtitle={title} footer={backToSignIn}>
      <form
        className={CARD}
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          setTried(true)
          if (password === again) reset.mutate()
        }}
      >
        {reset.isError && (
          <Notice>
            {reset.error.message}
            {expired && (
              <>
                {' '}
                <Link to="/forgot-password" className={LINK}>
                  Send a new link
                </Link>
              </>
            )}
          </Notice>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-password">New password</Label>
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            autoFocus
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-describedby="new-password-hint"
          />
          <StrengthHint password={password} id="new-password-hint" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="again">Type it again</Label>
          <Input
            id="again"
            type="password"
            autoComplete="new-password"
            required
            value={again}
            onChange={(e) => setAgain(e.target.value)}
            aria-invalid={mismatch || undefined}
            aria-describedby={mismatch ? 'again-error' : undefined}
          />
          {mismatch && (
            <p id="again-error" role="alert" className="text-small text-studio-danger">
              The two passwords don’t match.
            </p>
          )}
        </div>
        {!invite && <p className="text-small text-studio-muted">Every browser signed in to your account will be signed out.</p>}
        <Button type="submit" variant="primary" size="lg" loading={reset.isPending} disabled={password.length < MIN_PASSWORD || !again}>
          <KeyRound aria-hidden />
          {invite ? 'Set password and sign in' : 'Save and sign in'}
        </Button>
      </form>
    </AuthLayout>
  )
}

// where an expired or unknown confirm link lands (the server redirects here)
export function VerifyEmailPage() {
  const me = useMe()
  const resend = useMutation({ mutationFn: (email: string) => api.auth.resendVerification(email) })
  if (me.data?.verified) return <Navigate to="/" replace />
  return (
    <AuthLayout subtitle="Confirm your email" footer={backToSignIn}>
      <div className={CARD}>
        <Notice>That confirmation link has expired or has already been used.</Notice>
        {resend.isSuccess ? (
          <Notice tone="ok">If that address is waiting to be confirmed, a new link is on its way.</Notice>
        ) : (
          <>
            {resend.isError && <Notice>{resend.error.message}</Notice>}
            <EmailForm submitLabel="Send a new link" pending={resend.isPending} onSend={(email) => resend.mutate(email)} />
          </>
        )}
      </div>
    </AuthLayout>
  )
}
