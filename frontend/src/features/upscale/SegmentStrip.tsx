import type { SegmentStatus, UpscaleSegment } from '@/lib/types'
import { segmentLine } from '@/lib/upscale'
import { cn } from '@/lib/utils'

const CELL: Record<SegmentStatus, string> = {
  queued: 'bg-studio-raised',
  generating: 'bg-studio-accent shimmer',
  done: 'bg-studio-success',
  failed: 'bg-studio-danger',
}

/**
 * Hour-long films have hundreds of segments, so the strip is a single picture (not buttons)
 * and the text line carries the actual state for screen readers.
 */
export function SegmentStrip({ segments, message, className }: { segments: UpscaleSegment[]; message?: string | null; className?: string }) {
  const done = segments.filter((s) => s.status === 'done').length
  const failed = segments.filter((s) => s.status === 'failed').length
  const summary = segments.length
    ? `${done} of ${segments.length} segments done${failed ? `, ${failed} failed` : ''}`
    : 'Segments not split yet'
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="text-small text-studio-muted" aria-live="polite">
        {segmentLine(segments, message)}
      </span>
      {segments.length > 0 && (
        <div role="img" aria-label={summary} title={summary} className="flex h-2 gap-px overflow-hidden rounded-full">
          {segments.map((s) => (
            <span
              key={s.idx}
              data-status={s.status}
              className={cn('min-w-px flex-1', CELL[s.status])}
              style={{ flexGrow: Math.max(0.1, s.t_end - s.t_start) }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
