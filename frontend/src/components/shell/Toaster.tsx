import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { AlertTriangle, CheckCircle2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useToasts, type Toast } from '@/stores/toasts'

const LIFETIME_MS = 12_000

function ToastCard({ toast }: { toast: Toast }) {
  const dismiss = useToasts((s) => s.dismiss)
  const navigate = useNavigate()
  const [held, setHeld] = useState(false)

  // stays while hovered or focused, so nobody loses it mid-read
  useEffect(() => {
    if (held) return
    const t = setTimeout(() => dismiss(toast.id), LIFETIME_MS)
    return () => clearTimeout(t)
  }, [held, dismiss, toast.id])

  const failed = toast.tone === 'failed'
  return (
    <li
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      className={cn(
        'pointer-events-auto flex items-start gap-2.5 rounded-[8px] border bg-studio-raised p-3 shadow-pop motion-safe:animate-fade-in',
        failed ? 'border-studio-danger/60' : 'border-studio-gold/70',
      )}
    >
      {failed ? <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-studio-danger" /> : <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-studio-success" />}
      <div className="min-w-0 flex-1">
        <p className="text-body font-medium">{toast.title}</p>
        {toast.detail && <p className="text-small text-studio-muted">{toast.detail}</p>}
      </div>
      {toast.to && (
        <Button
          type="button"
          size="sm"
          variant={failed ? 'secondary' : 'primary'}
          onClick={() => {
            dismiss(toast.id)
            navigate(toast.to!)
          }}
        >
          Open
        </Button>
      )}
      <button type="button" onClick={() => dismiss(toast.id)} aria-label="Dismiss" className="rounded-[4px] p-1 text-studio-muted hover:bg-studio-panel-hover hover:text-studio-text">
        <X aria-hidden className="size-3.5" />
      </button>
    </li>
  )
}

/** "Finished — Open" notes for jobs started in this tab. Never modal; the work carries on behind them. */
export function Toaster() {
  const toasts = useToasts((s) => s.toasts)
  return (
    <div role="region" aria-label="Notifications" className="pointer-events-none fixed bottom-20 right-3 z-[55] w-[min(380px,calc(100vw-24px))] md:bottom-4 md:right-4">
      <ol aria-live="polite" aria-relevant="additions text" className="flex flex-col gap-2">
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} />
        ))}
      </ol>
    </div>
  )
}
