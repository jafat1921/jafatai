import { ImageIcon, Info, Link2, Loader2, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { StatusPill } from '@/components/studio/status-pill'
import { useJob } from '@/hooks/useJobs'
import { generationStatus, isPendingGeneration, scoreText } from '@/lib/status'
import type { Generation } from '@/lib/types'
import { cn } from '@/lib/utils'

interface Props {
  side: 'START' | 'END'
  frame: Generation | null | undefined
  alt: string
  aspectClass: string
  selected: boolean
  onSelect: () => void
  // set when this START is the previous shot's END (Continue seam)
  linkedFrom?: string
  onGenerate?: () => void
  generating?: boolean
}

export function FrameSlot({ side, frame, alt, aspectClass, selected, onSelect, linkedFrom, onGenerate, generating }: Props) {
  const job = useJob(frame?.job_id)
  const pending = frame ? isPendingGeneration(frame.status) : false
  const score = scoreText(frame?.score)
  const linked = linkedFrom !== undefined
  const label = `${side} frame${linked ? `, linked to ${linkedFrom} END` : ''}`

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <span className="section-label">{side}</span>
        {linked && (
          <span className="inline-flex items-center gap-1 text-small text-studio-accent-hover">
            <Link2 aria-hidden className="size-3" />
            linked
          </span>
        )}
        {score && <span className="ml-auto font-mono text-small text-studio-muted">★ {score}</span>}
      </div>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        aria-label={`${label}${frame ? `, ${generationStatus(frame.status).label}` : ', empty'}`}
        className={cn(
          'darkroom relative w-full overflow-hidden rounded-[6px] transition-shadow duration-150',
          aspectClass,
          selected ? 'ring-2 ring-studio-accent ring-offset-2 ring-offset-studio-panel' : 'hover:brightness-110',
          !frame && 'border-dashed',
        )}
      >
        {frame?.media_url && !pending ? (
          <img src={frame.media_url} alt={alt} className="size-full object-cover" loading="lazy" />
        ) : pending ? (
          <span className="shimmer-dark flex size-full items-center justify-center">
            <Loader2 aria-hidden className="size-5 animate-spin text-studio-on-dark-muted" />
          </span>
        ) : (
          <span className="flex size-full flex-col items-center justify-center gap-1 text-studio-on-dark-muted">
            <ImageIcon aria-hidden className="size-5" />
            <span className="text-small">{linked ? `Waiting for ${linkedFrom} END` : 'No frame yet'}</span>
          </span>
        )}
        {linked && (
          <span className="absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded-full bg-studio-darkroom/85 px-1.5 py-0.5 text-[11px] text-studio-on-dark">
            <Link2 aria-hidden className="size-3" />
            {linkedFrom} END
          </span>
        )}
      </button>
      <div className="flex min-h-7 items-center gap-1.5">
        {frame && (
          <StatusPill
            status={generationStatus(frame.status, frame.status === 'generating' ? job?.progress : undefined)}
          />
        )}
        {linked ? (
          <Tooltip content="With a Continue seam this START is the previous shot's END frame (the same file), so it isn't generated here. Switch the seam to Cut for a fresh START.">
            <span
              tabIndex={0}
              className="ml-auto inline-flex items-center gap-1 text-small text-studio-muted underline decoration-dotted underline-offset-2"
            >
              <Info aria-hidden className="size-3" />
              Shared frame
            </span>
          </Tooltip>
        ) : (
          onGenerate &&
          (!frame || frame.status === 'failed') && (
            <Button size="sm" variant="secondary" onClick={onGenerate} loading={generating} className="ml-auto">
              <Wand2 aria-hidden />
              {frame ? 'Retry' : 'Generate'}
            </Button>
          )
        )}
      </div>
    </div>
  )
}
