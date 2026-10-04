import { useRef } from 'react'
import { Check, Film, Loader2 } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { StatusPill } from '@/components/studio/status-pill'
import { useJob } from '@/hooks/useJobs'
import { generationStatus, isPendingGeneration } from '@/lib/status'
import type { Generation } from '@/lib/types'
import { cn } from '@/lib/utils'

export function TakeThumb({
  take,
  n,
  label,
  selected,
  muted,
  aspectClass,
  onSelect,
}: {
  take: Generation
  n: number
  label: string
  selected: boolean
  muted: boolean
  aspectClass: string
  onSelect: () => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const job = useJob(take.job_id)
  const pending = isPendingGeneration(take.status)
  const approved = take.status === 'approved'

  return (
    <div className="flex w-44 shrink-0 flex-col gap-1">
      <button
        type="button"
        data-take-id={take.id}
        data-space-play
        aria-pressed={selected}
        aria-label={`Take ${n} of shot ${label}, ${generationStatus(take.status).label}. Press ${n} to pick, Space to play.`}
        onClick={onSelect}
        onMouseEnter={() => void video.current?.play().catch(() => {})}
        onMouseLeave={() => video.current?.pause()}
        className={cn(
          'darkroom relative w-full overflow-hidden rounded-[6px]',
          aspectClass,
          selected ? 'ring-2 ring-studio-accent ring-offset-2 ring-offset-studio-panel' : 'hover:brightness-110',
        )}
      >
        {take.media_url && !pending ? (
          <video
            ref={video}
            src={take.media_url}
            muted={muted}
            loop
            playsInline
            preload="metadata"
            className="size-full object-cover"
            aria-hidden
          />
        ) : pending ? (
          <span className="shimmer-dark flex size-full items-center justify-center">
            <Loader2 aria-hidden className="size-5 animate-spin text-studio-on-dark-muted" />
          </span>
        ) : (
          <span className="flex size-full items-center justify-center text-studio-on-dark-muted">
            <Film aria-hidden className="size-5" />
          </span>
        )}
        <span className="absolute left-1.5 top-1.5 rounded-[4px] bg-studio-darkroom/85 px-1.5 font-mono text-[11px] text-studio-on-dark">
          {n}
        </span>
        {approved && (
          <span className="absolute right-1.5 top-1.5 inline-flex items-center gap-0.5 rounded-full bg-studio-darkroom/85 px-1.5 text-[11px] text-studio-on-dark">
            <Check aria-hidden className="size-3" />
            Chosen
          </span>
        )}
      </button>
      {take.status === 'generating' ? (
        <Progress value={job?.progress ?? null} label={`Take ${n} rendering`} />
      ) : (
        <StatusPill status={generationStatus(take.status)} className="self-start" />
      )}
    </div>
  )
}
