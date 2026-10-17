import { useEffect, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router'
import { LogIn } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuthConfig, useLogin, useMe } from '@/hooks/useAuth'
import { ApiError, api } from '@/lib/api'
import { AuthLayout, CARD, LINK, Notice } from './AuthLayout'

export function LoginPage() {
  const me = useMe()
  const login = useLogin()
  const config = useAuthConfig()
  const navigate = useNavigate()
  const location = useLocation()
  const [params] = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  useEffect(() => {
    let cancelled = false
    api.auth
      .devLogin()
      .then((d) => {
        if (cancelled || !d.enabled) return
        // don't clobber anything the user already started typing
        setEmail((cur) => cur || d.email || '')
        setPassword((cur) => cur || d.password || '')
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const from = (location.state as { from?: string } | null)?.from
  const target = from && from !== '/login' ? from : '/'

  if (me.data) return <Navigate to={target} replace />

  const errorText = login.error
    ? login.error instanceof ApiError && login.error.status === 401
      ? 'That email and password don’t match. Check them and try again.'
      : login.error.message
    : null
  // ?verified=1 when a confirm link was opened a second time; the address is confirmed, a sign-in is all that's left
  const note = params.get('verified') ? 'Your email is confirmed. Sign in to carry on.' : null

  return (
    <AuthLayout
      subtitle="Sign in to your atelier"
      footer={
        config.data?.signup === 'open' && (
          <p className="text-studio-muted">
            New here?{' '}
            <Link to="/signup" className={LINK}>
              Create an account
            </Link>
          </p>
        )
      }
    >
      <form
        className={CARD}
        onSubmit={(e) => {
          e.preventDefault()
          login.mutate({ email: email.trim(), password }, { onSuccess: () => navigate(target, { replace: true }) })
        }}
        noValidate
      >
        {note && !errorText && <Notice tone="ok">{note}</Notice>}
        {errorText && <Notice>{errorText}</Notice>}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="username"
            autoFocus
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={!!errorText || undefined}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <Label htmlFor="password">Password</Label>
            <Link to="/forgot-password" className={`${LINK} text-small`}>
              Forgot password?
            </Link>
          </div>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={!!errorText || undefined}
          />
        </div>
        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={login.isPending}
          disabled={!email.trim() || !password}
        >
          <LogIn aria-hidden />
          Sign in
        </Button>
      </form>
    </AuthLayout>
  )
}
