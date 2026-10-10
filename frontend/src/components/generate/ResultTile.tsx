import { AlertTriangle, Check, Heart, Play } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { TilePicture, UpscaledBadge } from '@/components/media/TilePicture'
import { useJobs } from '@/hooks/useJobs'
import { useTileState } from '@/hooks/useMedia'
import { formatDuration } from '@/lib/duration'
import { tileRatio } from '@/lib/images'
import { mediaAlt } from '@/lib/media'
import { modelUsedId } from '@/lib/models'
import { DRAG_MIME, type Mods } from '@/lib/selection'
import type { Job, MediaItem } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useIsFavourite } from '@/stores/favourites'
import { AudioTile } from '@/features/audio/AudioTile'
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

/** Multi-select on a Library grid (P4). */
export interface TileSelect {
  selected: boolean
  // something is already picked: a plain click on the picture selects instead of opening
  active: boolean
  onSelect: (mods: Mods) => void
  // what a drag onto a folder carries (the whole selection when this tile is part of it)
  dragRefs?: () => string[]
}

interface Props {
  item: MediaItem
  handlers: TileHandlers
  // the aspect the request asked for; keeps the skeleton the same shape as the result
  aspectHint?: string | null
  // force a cell shape (the Library keeps uniform cells)
  ratio?: string
  showTitle?: boolean
  select?: TileSelect
  className?: string
}

export function ResultTile(props: Props) {
  // audio has no picture: a waveform you play in place
  if (props.item.kind === 'audio') return <AudioTile item={props.item} handlers={props.handlers} ratio={props.ratio} select={props.select} className={props.className} />
  return <PictureTile {...props} />
}

function PictureTile({ item, handlers, aspectHint, ratio, showTitle, select, className }: Props) {
  const { state, gen, progress, job } = useTileState(item)
  const position = useQueuePosition(job)
  const fav = useIsFavourite(item.id)
  const label = useModelLabels()
  const alt = mediaAlt(item)
  const used = label(modelUsedId(gen?.params, item.params, { model: item.model }))

  return (
    <div
      className={cn('group/tile flex min-w-0 flex-col gap-1', className)}
      data-select-id={select ? item.id : undefined}
      draggable={!!select?.dragRefs}
      onDragStart={
        select?.dragRefs
          ? (e) => {
              e.dataTransfer.setData(DRAG_MIME, JSON.stringify(select.dragRefs!()))
              e.dataTransfer.effectAllowed = 'move'
            }
          : undefined
      }
    >
      <div
        className={cn('darkroom relative w-full overflow-hidden rounded-[6px]', select?.selected && 'ring-2 ring-studio-accent ring-offset-2 ring-offset-studio-bg')}
        style={{ aspectRatio: ratio ?? tileRatio(item, aspectHint) }}
      >
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
          <button
            type="button"
            onClick={(e) => {
              if (select && (select.active || e.shiftKey || e.ctrlKey || e.metaKey)) select.onSelect(e)
              else handlers.open(item)
            }}
            className="relative block size-full"
            aria-label={`View ${alt}`}
          >
            <TilePicture item={item} alt={alt} fallbackUrl={gen?.thumb_url ?? gen?.media_url} />
          </button>
        )}

        {state === 'pending' && progress != null && (
          <div className="absolute inset-x-2 bottom-2">
            <Progress value={progress} label={`${alt} progress`} />
          </div>
        )}
        {select && (
          <button
            type="button"
            role="checkbox"
            aria-checked={select.selected}
            aria-label={`Select ${alt}`}
            onClick={(e) => select.onSelect({ shiftKey: e.shiftKey, ctrlKey: true })}
            className={cn(
              'absolute left-1.5 top-1.5 z-10 flex size-6 items-center justify-center rounded-full border-2 border-studio-on-dark transition-opacity duration-150',
              select.selected ? 'bg-studio-accent text-studio-accent-fg' : 'bg-studio-darkroom/60 text-transparent',
              select.selected || select.active ? 'opacity-100' : 'opacity-0 group-hover/tile:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100',
            )}
          >
            <Check aria-hidden className="size-3.5" />
          </button>
        )}
        {fav && state !== 'pending' && (
          <span className={cn('pointer-events-none absolute top-1.5 rounded-full bg-studio-darkroom/70 p-1 text-studio-on-dark', select ? 'left-9' : 'left-1.5')}>
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
        {state === 'ready' && <UpscaledBadge item={item} />}
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
