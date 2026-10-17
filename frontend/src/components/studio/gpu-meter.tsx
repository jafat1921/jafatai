import { Progress } from '@/components/ui/progress'
import { fmtClock, fmtMinutes } from '@/hooks/useUsage'
import type { Usage } from '@/lib/types'
import { cn } from '@/lib/utils'

/** "12 of 30 min today, resets 05:00" with a bar under it (contract v39). */
export function GpuMeter({ usage, className }: { usage: Usage; className?: string }) {
  if (usage.unlimited || usage.gpu_min_day == null) {
    return (
      <p className={cn('text-body', className)}>
        {fmtMinutes(usage.used_min_today)} GPU min today <span className="text-studio-muted">· no daily limit</span>
      </p>
    )
  }
  const limit = usage.gpu_min_day
  const share = limit > 0 ? usage.used_min_today / limit : 1
  const text = `${fmtMinutes(usage.used_min_today)} of ${fmtMinutes(limit)} min today, resets ${fmtClock(usage.resets_at)}`
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <p className="text-body tabular-nums">
        {text}
        {usage.grant_min > 0 && <span className="text-studio-muted"> · includes {fmtMinutes(usage.grant_min)} extra</span>}
      </p>
      <Progress value={share} label={`GPU minutes used today: ${text}`} className={cn(share >= 1 && '[&>div]:bg-studio-warning')} />
    </div>
  )
}
