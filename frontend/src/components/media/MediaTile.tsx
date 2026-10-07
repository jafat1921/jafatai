import { AlertTriangle, Check, Film, ImageIcon, Loader2, Play } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { useTileState } from '@/hooks/useMedia'
import { formatDuration } from '@/lib/duration'
import { mediaAlt } from '@/lib/media'
import type { TileState } from '@/lib/images'
import type { MediaItem } from '@/lib/types'
import { cn } from '@/lib/utils'

const ORIGIN: Record<MediaItem['origin'], string> = { generated: 'Generated', upload: 'Upload', project: 'From a project' }

interface Props {
  item: MediaItem
  onOpen?: () => void
  // picker mode: the tile is a toggle instead of a link to the detail view
  selectable?: boolean
  selected?: boolean
  disabled?: boolean
  onToggle?: () => void
  actions?: (state: TileState) => React.ReactNode
  className?: string
}

export function MediaTile({ item, onOpen, selectable, selected, disabled, onToggle, actions, className }: Props) {
  const { state, gen, progress, job } = useTileState(item)
  const url = item.thumb_url ?? item.media_url ?? gen?.media_url
  const alt = mediaAlt(item)
  // uniform cells keep the grid scannable; the detail view shows the real shape
  const ratio = item.kind === 'video' ? '16 / 9' : '1 / 1'

  const picture = (
    <div className="darkroom relative w-full overflow-hidden rounded-[6px]" style={{ aspectRatio: ratio }}>
      {state === 'pending' ? (
        <div className="shimmer-dark flex size-full flex-col items-center justify-center gap-2 p-3 text-studio-on-dark-muted">
          <Loader2 aria-hidden className="size-5 motion-safe:animate-spin" />
          <span className="text-small">{job?.status === 'running' ? 'Generating…' : 'Waiting in queue'}</span>
        </div>
      ) : state === 'failed' ? (
        <div className="flex size-full flex-col items-center justify-center gap-1 p-3 text-center text-studio-on-dark">
          <AlertTriangle aria-hidden className="size-5" />
          <span className="text-small">Failed</span>
          {(job?.error || gen?.note) && <span className="line-clamp-2 text-small text-studio-on-dark-muted">{job?.error ?? gen?.note}</span>}
        </div>
      ) : url && item.kind === 'image' ? (
        <img src={url} alt={alt} loading="lazy" className="size-full object-cover motion-safe:animate-fade-in" />
      ) : url && !item.thumb_url ? (
        <video src={url} aria-label={alt} muted playsInline preload="metadata" className="size-full object-cover" />
      ) : url ? (
        <img src={url} alt={alt} loading="lazy" className="size-full object-cover" />
      ) : (
        <div className="flex size-full items-center justify-center text-studio-on-dark-muted">
          {item.kind === 'video' ? <Film aria-hidden className="size-6" /> : <ImageIcon aria-hidden className="size-6" />}
        </div>
      )}
      {item.kind === 'video' && state === 'ready' && (
        <span aria-hidden className="absolute bottom-1.5 right-1.5 flex items-center gap-1 rounded-[4px] bg-studio-darkroom/85 px-1.5 font-mono text-[11px] text-studio-on-dark">
          <Play className="size-3" />
          {item.duration_s ? formatDuration(Math.round(item.duration_s)) : 'Video'}
        </span>
      )}
      {selectable && (
        <span
          aria-hidden
          className={cn(
            'absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-full border-2 border-studio-on-dark',
            selected ? 'bg-studio-accent text-studio-accent-fg' : 'bg-studio-darkroom/60',
          )}
        >
          {selected && <Check className="size-3.5" />}
        </span>
      )}
      {state === 'pending' && progress != null && (
        <div className="absolute inset-x-2 bottom-2">
          <Progress value={progress} label={`${alt} progress`} />
        </div>
      )}
    </div>
  )

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {selectable ? (
        <button
          type="button"
          aria-pressed={selected}
          disabled={disabled && !selected}
          onClick={onToggle}
          className={cn('rounded-[8px] p-0.5 text-left', selected && 'ring-2 ring-studio-accent', disabled && !selected && 'opacity-50')}
          aria-label={`${alt}${selected ? ', selected' : ''}`}
        >
          {picture}
        </button>
      ) : onOpen ? (
        <button type="button" onClick={onOpen} className="rounded-[6px] text-left" aria-label={`View ${alt}`}>
          {picture}
        </button>
      ) : (
        picture
      )}
      <div className="flex min-w-0 items-center gap-1.5 px-0.5">
        <span className="min-w-0 flex-1 truncate text-small font-medium" title={alt}>
          {alt}
        </span>
        <span className="shrink-0 text-[11px] text-studio-muted">{ORIGIN[item.origin]}</span>
      </div>
      {actions?.(state)}
    </div>
  )
}
