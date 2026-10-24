import * as React from 'react'
import { Link } from 'react-router'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { MarketingLayout } from '@/features/landing/MarketingLayout'
import { cn } from '@/lib/utils'

// the burnt-edge sheet in AuthLayout is the card now; this only lays the form out
export const CARD = 'flex flex-col gap-4'

export function AuthLayout({ subtitle, children, footer }: { subtitle: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <MarketingLayout className="auth">
      <div className="auth-main animate-fade-in">
        <Link className="back" to="/">
          <span aria-hidden>←</span> Back to jafat.ai
        </Link>
        <div className="auth-head">
          {/* the logo's cream ground melts into the parchment under multiply */}
          <img src="/brand/jafat-logo-horizontal-light.png" alt="Jafat logo" width={2000} height={600} />
          <h1>Jafat AI Studio</h1>
          <p>{subtitle}</p>
        </div>
        <div className="sheet auth-sheet">{children}</div>
        {footer && <div className="auth-foot">{footer}</div>}
      </div>
    </MarketingLayout>
  )
}

export function Notice({ tone = 'error', children, id }: { tone?: 'error' | 'ok'; children: React.ReactNode; id?: string }) {
  const ok = tone === 'ok'
  return (
    <div
      id={id}
      role={ok ? 'status' : 'alert'}
      className={cn(
        'flex items-start gap-2 rounded-[6px] border p-2.5 text-body',
        ok ? 'border-studio-success/50 bg-studio-success/5' : 'border-studio-danger/40 bg-studio-danger/5',
      )}
    >
      {ok ? (
        <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-studio-success" />
      ) : (
        <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-studio-danger" />
      )}
      <div>{children}</div>
    </div>
  )
}

export const LINK =
  'font-medium text-studio-accent underline-offset-2 hover:text-studio-accent-hover hover:underline focus-visible:rounded-[4px] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-studio-gold/50'

export const MIN_PASSWORD = 10

// a hint, not a rule: the server only insists on the length
export function passwordStrength(pw: string): { label: string; level: 0 | 1 | 2 | 3 } {
  if (!pw) return { label: '', level: 0 }
  if (pw.length < MIN_PASSWORD) return { label: `${MIN_PASSWORD - pw.length} more character${MIN_PASSWORD - pw.length === 1 ? '' : 's'} to go`, level: 0 }
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length
  const score = (pw.length >= 14 ? 1 : 0) + (pw.length >= 18 ? 1 : 0) + (kinds >= 3 ? 1 : 0)
  if (score >= 2) return { label: 'Strong', level: 3 }
  if (score === 1) return { label: 'Good', level: 2 }
  return { label: 'Fair: a longer phrase is harder to guess', level: 1 }
}

export function StrengthHint({ password, id }: { password: string; id: string }) {
  const s = passwordStrength(password)
  return (
    <div id={id} className="flex items-center gap-2" aria-live="polite">
      <span aria-hidden className="flex gap-1">
        {[1, 2, 3].map((n) => (
          <span
            key={n}
            className={cn('h-1 w-6 rounded-full', s.level >= n ? (s.level === 1 ? 'bg-studio-warning' : 'bg-studio-success') : 'bg-studio-border')}
          />
        ))}
      </span>
      <span className="text-small text-studio-muted">{s.label || `At least ${MIN_PASSWORD} characters`}</span>
    </div>
  )
}
