import { AlertTriangle, Film, Heart, ImageIcon, Play } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { useJobs } from '@/hooks/useJobs'
import { useTileState } from '@/hooks/useMedia'
import { formatDuration } from '@/lib/duration'
import { tileRatio } from '@/lib/images'
import { mediaAlt } from '@/lib/media'
import { modelUsedId } from '@/lib/models'
import type { Job, MediaItem } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useIsFavourite } from '@/stores/favourites'
import { TileActions, type TileHandlers } from './TileActions'
import { useModelLabels } from './useModelLabel'

const ordinal = (n: number) => (n === 1 ? 'next' : `${n}${n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'} in line`)

function useQueuePosition(job: Job | undefined) {
  const { data } = useJobs()
  if (job?.status !== 'queued') return null
  const waiting = (data ?? []).filter((j) => j.status === 'queued').sort((a, b) => a.created_at.localeCompare(b.created_at))
  const i = waiting.findIndex((j) => j.id === job.id)
  return i === -1 ? null : i + 1
}

interface Props {
  item: MediaItem
  handlers: TileHandlers
  // the aspect the request asked for; keeps the skeleton the same shape as the result
  aspectHint?: string | null
  // force a cell shape (the Library keeps uniform cells)
  ratio?: string
  showTitle?: boolean
  className?: string
}

export function ResultTile({ item, handlers, aspectHint, ratio, showTitle, className }: Props) {
  const { state, gen, progress, job } = useTileState(item)
  const position = useQueuePosition(job)
  const fav = useIsFavourite(item.id)
  const label = useModelLabels()
  const url = item.thumb_url ?? item.media_url ?? gen?.media_url
  const alt = mediaAlt(item)
  const used = label(modelUsedId(gen?.params, item.params, { model: item.model }))

  return (
    <div className={cn('group/tile flex min-w-0 flex-col gap-1', className)}>
      <div className="darkroom relative w-full overflow-hidden rounded-[6px]" style={{ aspectRatio: ratio ?? tileRatio(item, aspectHint) }}>
        {state === 'pending' ? (
          <div className="shimmer-dark flex size-full flex-col items-center justify-center gap-1.5 p-3 text-center text-studio-on-dark" role="status">
            <span className="font-mono text-heading">{progress != null ? `${Math.round(progress * 100)}%` : position ? `#${position}` : '…'}</span>
            <span className="text-small text-studio-on-dark-muted">
              {job?.status === 'running' ? 'Generating' : position ? `Queued, ${ordinal(position)}` : 'Waiting in queue'}
            </span>
            <span className="sr-only">{alt}</span>
          </div>
        ) : state === 'failed' ? (
          <div className="flex size-full flex-col items-center justify-center gap-1 p-3 text-center text-studio-on-dark">
            <AlertTriangle aria-hidden className="size-5" />
            <span className="text-small">Failed</span>
            {(job?.error || gen?.note) && <span className="line-clamp-2 text-small text-studio-on-dark-muted">{job?.error ?? gen?.note}</span>}
          </div>
        ) : (
          <button type="button" onClick={() => handlers.open(item)} className="block size-full" aria-label={`View ${alt}`}>
            {url && (item.kind === 'image' || item.thumb_url) ? (
              <img src={url} alt={alt} loading="lazy" className="size-full object-cover motion-safe:animate-fade-in" />
            ) : url ? (
              <video src={url} aria-label={alt} muted playsInline preload="metadata" className="size-full object-cover" />
            ) : (
              <span className="flex size-full items-center justify-center text-studio-on-dark-muted">
                {item.kind === 'video' ? <Film aria-hidden className="size-6" /> : <ImageIcon aria-hidden className="size-6" />}
              </span>
            )}
          </button>
        )}

        {state === 'pending' && progress != null && (
          <div className="absolute inset-x-2 bottom-2">
            <Progress value={progress} label={`${alt} progress`} />
          </div>
        )}
        {fav && state !== 'pending' && (
          <span className="pointer-events-none absolute left-1.5 top-1.5 rounded-full bg-studio-darkroom/70 p-1 text-studio-on-dark">
            <Heart aria-hidden className="size-3 fill-current" />
            <span className="sr-only">Favourite</span>
          </span>
        )}
        {item.kind === 'video' && state === 'ready' && (
          <span aria-hidden className="pointer-events-none absolute bottom-1.5 right-1.5 flex items-center gap-1 rounded-[4px] bg-studio-darkroom/85 px-1.5 font-mono text-[11px] text-studio-on-dark">
            <Play className="size-3" />
            {item.duration_s ? formatDuration(Math.round(item.duration_s)) : 'Video'}
          </span>
        )}
        {state !== 'pending' && (
          <TileActions
            item={item}
            state={state}
            handlers={handlers}
            fav={fav}
            className={cn(
              'absolute inset-x-1 top-1 justify-end opacity-0 transition-opacity duration-150 group-hover/tile:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100',
              state === 'failed' && 'opacity-100',
            )}
          />
        )}
      </div>
      {showTitle && (
        <span className="truncate px-0.5 text-small font-medium" title={alt}>
          {alt}
        </span>
      )}
      <div className="flex min-w-0 items-center gap-1.5 px-0.5 text-[11px] text-studio-muted">
        {used ? (
          <span className="truncate" title={`Made with ${used}`}>
            <span className="sr-only">Made with </span>
            {used}
          </span>
        ) : (
          <span className="truncate">{item.origin === 'upload' ? 'Upload' : item.origin === 'project' ? 'From a project' : ''}</span>
        )}
        {item.width && item.height ? <span className="ml-auto shrink-0 font-mono">{`${item.width}×${item.height}`}</span> : null}
      </div>
    </div>
  )
}
