import { AlertTriangle, Ban, Check, Clock, Eye, Film, Loader2, Pencil, RefreshCcw, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { StatusIcon, StatusView } from '@/lib/status'
import { cn } from '@/lib/utils'

const ICONS: Record<StatusIcon, React.ComponentType<{ className?: string }>> = {
  clock: Clock,
  spinner: Loader2,
  eye: Eye,
  check: Check,
  x: X,
  alert: AlertTriangle,
  pencil: Pencil,
  film: Film,
  ban: Ban,
  stale: RefreshCcw,
}

export function StatusPill({ status, className }: { status: StatusView; className?: string }) {
  const Icon = ICONS[status.icon]
  return (
    <Badge tone={status.tone} className={className}>
      <Icon aria-hidden className={cn(status.icon === 'spinner' && 'animate-spin')} />
      {status.label}
    </Badge>
  )
}
