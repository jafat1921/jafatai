import { useEffect, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { AlertTriangle, Clapperboard, LogIn } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useLogin, useMe } from '@/hooks/useAuth'
import { Ornament } from '@/components/studio/ornament'
import { ApiError, api } from '@/lib/api'

export function LoginPage() {
  const me = useMe()
  const login = useLogin()
  const navigate = useNavigate()
  const location = useLocation()
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
  const target = from && from !== '/login' ? from : '/projects'

  if (me.data) return <Navigate to={target} replace />

  const errorText = login.error
    ? login.error instanceof ApiError && login.error.status === 401
      ? 'That email and password don’t match. Check them and try again.'
      : login.error.message
    : null

  return (
    <main className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm animate-fade-in">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="flex size-11 items-center justify-center rounded-[8px] bg-studio-gold text-studio-darkroom shadow-card">
            <Clapperboard aria-hidden className="size-5" />
          </div>
          <div>
            <h1 className="font-display text-[30px] font-bold leading-9">Mix AI Cinema Studio</h1>
            <Ornament className="my-2 justify-center" />
            <p className="text-body text-studio-muted">Sign in to your atelier</p>
          </div>
        </div>
        <form
          className="flex flex-col gap-4 rounded-[8px] border-[3px] border-double border-studio-gold/80 bg-studio-raised p-5 shadow-pop"
          onSubmit={(e) => {
            e.preventDefault()
            login.mutate({ email: email.trim(), password }, { onSuccess: () => navigate(target, { replace: true }) })
          }}
          noValidate
        >
          {errorText && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-[6px] border border-studio-danger/40 bg-studio-danger/5 p-2.5 text-body"
            >
              <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-studio-danger" />
              {errorText}
            </div>
          )}
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
            <Label htmlFor="password">Password</Label>
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
      </div>
    </main>
  )
}
