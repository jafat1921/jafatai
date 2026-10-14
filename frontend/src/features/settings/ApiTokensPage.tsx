import { useId, useRef, useState } from 'react'
import { Link, Navigate } from 'react-router'
import { ArrowLeft, Check, Copy, ExternalLink, KeyRound } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { fieldClass, Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/studio/states'
import { useMe } from '@/hooks/useAuth'
import { useCreateToken, useRevokeToken, useTokens } from '@/hooks/useTokens'
import type { ApiToken, ApiTokenCreated, TokenExpiry, TokenScope } from '@/lib/types'
import { cn, timeAgo } from '@/lib/utils'
import { Card } from './SystemChecks'

const SCOPES: { id: TokenScope; label: string; hint: string }[] = [
  { id: 'read', label: 'Read', hint: 'List and download: projects, the Library, jobs, results.' },
  { id: 'generate', label: 'Generate', hint: 'Start work and change things: images, video, audio, sheets.' },
  { id: 'manage', label: 'Manage', hint: 'Delete things. Leave this off unless the script needs it.' },
]

const EXPIRY: { value: string; label: string }[] = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'Never' },
]

const DOCS_URL = '/api/docs'

const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

function NewTokenCard({ onCreated }: { onCreated: (t: ApiTokenCreated) => void }) {
  const uid = useId()
  const create = useCreateToken()
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<TokenScope[]>(['read', 'generate'])
  const [expiry, setExpiry] = useState('90')

  const toggle = (id: TokenScope, on: boolean) => setScopes((s) => (on ? [...s, id] : s.filter((x) => x !== id)))
  const ready = name.trim() !== '' && scopes.length > 0

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!ready) return
    const expires_days = (expiry === 'never' ? null : Number(expiry)) as TokenExpiry
    create.mutate(
      { name: name.trim(), scopes, expires_days },
      {
        onSuccess: (made) => {
          setName('')
          onCreated(made)
        },
      },
    )
  }

  return (
    <Card title="New token">
      <form onSubmit={submit} className="flex flex-col gap-3" aria-describedby={`${uid}-about`}>
        <p id={`${uid}-about`} className="text-small text-studio-muted">
          A token acts as you, limited to the scopes you tick. Your role still applies.
        </p>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${uid}-name`} className="text-small font-medium">
            Name
          </label>
          <Input
            id={`${uid}-name`}
            value={name}
            maxLength={120}
            placeholder="e.g. Nightly renders"
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
          />
        </div>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-small font-medium">Scopes</legend>
          {SCOPES.map((s) => (
            <label key={s.id} className="flex items-start gap-2.5 rounded-[6px] border border-studio-border bg-studio-raised p-2">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-studio-accent"
                checked={scopes.includes(s.id)}
                onChange={(e) => toggle(s.id, e.target.checked)}
                aria-describedby={`${uid}-${s.id}`}
              />
              <span>
                <span className="block text-body font-medium">{s.label}</span>
                <span id={`${uid}-${s.id}`} className="block text-small text-studio-muted">
                  {s.hint}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${uid}-expiry`} className="text-small font-medium">
            Expires after
          </label>
          <select id={`${uid}-expiry`} value={expiry} onChange={(e) => setExpiry(e.target.value)} className={cn(fieldClass, 'h-8 sm:w-48')}>
            {EXPIRY.map((x) => (
              <option key={x.value} value={x.value}>
                {x.label}
              </option>
            ))}
          </select>
        </div>
        {create.isError && (
          <p role="alert" className="text-small text-studio-danger">
            {create.error.message}
          </p>
        )}
        <Button type="submit" variant="primary" className="self-start" loading={create.isPending} disabled={!ready}>
          <KeyRound aria-hidden />
          Create token
        </Button>
      </form>
    </Card>
  )
}

function ShowOnceDialog({ made, onClose }: { made: ApiTokenCreated | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const fieldRef = useRef<HTMLInputElement>(null)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(made?.token ?? '')
      setCopied(true)
    } catch {
      // clipboard blocked (http, old browser): select it so Ctrl+C works
      fieldRef.current?.select()
    }
  }

  return (
    <Dialog
      open={made !== null}
      onOpenChange={(open) => {
        if (!open) {
          setCopied(false)
          onClose()
        }
      }}
    >
      <DialogContent onOpenAutoFocus={(e) => (e.preventDefault(), fieldRef.current?.select())}>
        <DialogHeader>
          <DialogTitle>Copy your token now</DialogTitle>
          <DialogDescription>
            This is the only time “{made?.name}” is shown in full. Store it somewhere safe, such as a password manager or
            your script's environment. If you lose it, revoke it and make a new one.
          </DialogDescription>
        </DialogHeader>
        <label htmlFor="new-token-value" className="text-small font-medium">
          Token
        </label>
        <div className="mt-1 flex gap-2">
          <Input id="new-token-value" ref={fieldRef} readOnly value={made?.token ?? ''} className="font-mono text-small" spellCheck={false} />
          <Button onClick={copy} aria-live="polite">
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <p className="mt-3 text-small text-studio-muted">
          Send it as <code className="font-mono">Authorization: Bearer …</code> with each request.
        </p>
        <DialogFooter>
          <Button variant="primary" onClick={() => (setCopied(false), onClose())}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const STATUS_TONE = { active: 'success', expired: 'warning', revoked: 'neutral' } as const

function TokenRow({ t, onRevoke }: { t: ApiToken; onRevoke: (t: ApiToken) => void }) {
  const live = t.status === 'active'
  return (
    <li className={cn('flex flex-wrap items-start gap-x-4 gap-y-1.5 py-3', !live && 'opacity-75')}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{t.name}</span>
          <Badge tone={STATUS_TONE[t.status]}>{t.status}</Badge>
        </div>
        <p className="font-mono text-small text-studio-muted">mxa_{t.prefix}_…</p>
        <p className="mt-1 flex flex-wrap gap-1" aria-label="Scopes">
          {t.scopes.map((s) => (
            <Badge key={s} tone="accent">
              {s}
            </Badge>
          ))}
        </p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-small">
        <dt className="text-studio-muted">Last used</dt>
        <dd>{t.last_used_at ? timeAgo(t.last_used_at) : 'Never'}</dd>
        <dt className="text-studio-muted">{t.status === 'expired' ? 'Expired' : 'Expires'}</dt>
        <dd>{t.expires_at ? date(t.expires_at) : 'Never'}</dd>
        <dt className="text-studio-muted">Created</dt>
        <dd>{date(t.created_at)}</dd>
      </dl>
      {live && (
        <Button size="sm" variant="outline" className="self-center" onClick={() => onRevoke(t)} aria-label={`Revoke ${t.name}`}>
          Revoke
        </Button>
      )}
    </li>
  )
}

function TokensCard() {
  const tokens = useTokens()
  const revoke = useRevokeToken()
  const [target, setTarget] = useState<ApiToken | null>(null)

  return (
    <Card title="Your tokens">
      {tokens.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading tokens">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : tokens.isError ? (
        <ErrorState error={tokens.error} onRetry={() => tokens.refetch()} />
      ) : tokens.data.length === 0 ? (
        <p className="text-body text-studio-muted">No tokens yet. Make one when a script or tool needs to call the studio.</p>
      ) : (
        <ul className="divide-y divide-studio-border">
          {tokens.data.map((t) => (
            <TokenRow key={t.id} t={t} onRevoke={setTarget} />
          ))}
        </ul>
      )}
      {revoke.isError && (
        <p role="alert" className="text-small text-studio-danger">
          {revoke.error.message}
        </p>
      )}
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => !open && setTarget(null)}
        title={`Revoke “${target?.name ?? ''}”?`}
        description="Anything still using it stops working straight away. This can't be undone."
        confirmLabel="Revoke token"
        tone="danger"
        onConfirm={() => target && revoke.mutate(target.id)}
      />
    </Card>
  )
}

function DocsCard() {
  return (
    <Card title="API reference">
      <p className="text-body text-studio-muted">
        Every route with its fields and examples. Use <strong className="font-medium text-studio-text">Authorize</strong> to paste a token,
        then try calls from the page.
      </p>
      <Button asChild variant="secondary" className="self-start">
        <a href={DOCS_URL} target="_blank" rel="noreferrer">
          <ExternalLink aria-hidden />
          Open the API docs
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </Button>
    </Card>
  )
}

export function ApiTokensPage() {
  const { data: me, isPending } = useMe()
  const [made, setMade] = useState<ApiTokenCreated | null>(null)

  if (isPending) return null
  // same as the server: while PUBLIC_API is off only the admin gets here
  if (!me?.api_access) return <Navigate to="/settings" replace />

  return (
    <main data-f6-region tabIndex={-1} className="h-full overflow-y-auto focus-visible:outline-none" aria-labelledby="tokens-title">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-6 md:px-8">
        <div>
          <Link to="/settings" className="inline-flex items-center gap-1 text-small text-studio-muted hover:text-studio-text">
            <ArrowLeft aria-hidden className="size-3.5" />
            Settings
          </Link>
          <h1 id="tokens-title" className="font-display text-title font-semibold">
            API tokens
          </h1>
          <p className="text-body text-studio-muted">Let your own scripts and tools use the studio without your password.</p>
        </div>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div className="flex flex-col gap-4">
            <NewTokenCard onCreated={setMade} />
            {me.api_docs && <DocsCard />}
          </div>
          <TokensCard />
        </div>
        {/* TODO: "Connect to Claude" (MCP) card goes in this column next, under the tokens it uses */}
      </div>
      <ShowOnceDialog made={made} onClose={() => setMade(null)} />
    </main>
  )
}
