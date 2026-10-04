import * as React from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Ornament } from './ornament'

export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
}: {
  icon?: React.ReactNode
  title: string
  children?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-10 text-center', className)}>
      {icon && (
        <div className="mb-1 flex size-11 items-center justify-center rounded-[8px] border border-studio-border-strong bg-studio-raised text-studio-accent shadow-card [&_svg]:size-5">
          {icon}
        </div>
      )}
      <h3 className="font-display text-title font-semibold">{title}</h3>
      <Ornament />
      {children && <p className="max-w-sm text-body text-studio-muted">{children}</p>}
      {action && <div className="mt-2 flex gap-2">{action}</div>}
    </div>
  )
}

export function ErrorState({
  title = "Couldn't load this",
  error,
  onRetry,
  compact,
  className,
}: {
  title?: string
  error: unknown
  onRetry?: () => void
  compact?: boolean
  className?: string
}) {
  const detail = error instanceof Error ? error.message : String(error ?? '')
  return (
    <div
      role="alert"
      className={cn(
        'flex gap-3 rounded-[6px] border border-studio-danger/40 bg-studio-danger/5',
        compact ? 'items-center p-2' : 'items-start p-3',
        className,
      )}
    >
      <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-studio-danger" />
      <div className="min-w-0 flex-1">
        <p className="text-body font-medium">{title}</p>
        {detail && <p className="break-words text-small text-studio-muted">{detail}</p>}
      </div>
      {onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          <RotateCcw aria-hidden />
          Retry
        </Button>
      )}
    </div>
  )
}
