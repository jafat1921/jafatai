import { useEffect, useId } from 'react'
import { AlertTriangle, AudioLines, Check, Heart, Pause, Play } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { Tooltip } from '@/components/ui/tooltip'
import { TileActions, type TileHandlers } from '@/components/generate/TileActions'
import { useModelLabels } from '@/components/generate/useModelLabel'
import type { TileSelect } from '@/components/generate/ResultTile'
import { useTileState } from '@/hooks/useMedia'
import { useModels } from '@/hooks/useModels'
import { clock } from '@/lib/audio'
import { mediaAlt } from '@/lib/media'
import { modelUsedId } from '@/lib/models'
import { DRAG_MIME } from '@/lib/selection'
import type { MediaItem } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useIsFavourite } from '@/stores/favourites'
import { pauseAudio, togglePlay, usePlayer, useTrack } from './sharedAudio'

const audioLength = (item: MediaItem) => item.duration_s ?? (typeof item.params?.duration_s === 'number' ? item.params.duration_s : null)

interface Props {
  item: MediaItem
  handlers: TileHandlers
  ratio?: string
  select?: TileSelect
  className?: string
}

/** A song, cue or effect: waveform you can click to play, one track at a time across the app. */
export function AudioTile({ item, handlers, ratio, select, className }: Props) {
  const uid = useId()
  const { state, gen, progress, job } = useTileState(item)
  const fav = useIsFavourite(item.id)
  const label = useModelLabels()
  const { models } = useModels('audio')
  const track = useTrack(item.id)
  const alt = mediaAlt(item)
  const usedId = modelUsedId(gen?.params, item.params, { model: item.model })
  const used = label(usedId)
  const licence = models.find((m) => m.id === usedId)?.extra?.licence
  const src = item.media_url ?? gen?.media_url ?? null
  const wave = item.thumb_url ?? gen?.thumb_url ?? null
  const length = audioLength(item) ?? (track.duration || null)
  const pct = track.mine && length ? Math.min(100, (track.time / length) * 100) : 0

  // leaving the page shouldn't leave a track playing with no way to stop it
  useEffect(
    () => () => {
      if (usePlayer.getState().id === item.id) pauseAudio()
    },
    [item.id],
  )

  const onWave = (e: React.MouseEvent) => {
    if (select && (select.active || e.shiftKey || e.ctrlKey || e.metaKey)) return select.onSelect(e)
    if (src) togglePlay(item.id, src)
  }

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
        className={cn(
          'relative w-full overflow-hidden rounded-[6px] border border-studio-border-strong bg-studio-panel',
          select?.selected && 'ring-2 ring-studio-accent ring-offset-2 ring-offset-studio-bg',
        )}
        style={{ aspectRatio: ratio ?? '2 / 1' }}
      >
        {state === 'pending' ? (
          <div className="shimmer flex size-full flex-col items-center justify-center gap-1 p-3 text-center" role="status">
            <span className="font-mono text-heading">{progress != null ? `${Math.round(progress * 100)}%` : '…'}</span>
            <span className="text-small text-studio-muted">{job?.status === 'running' ? 'Composing' : 'Waiting in queue'}</span>
            <span className="sr-only">{alt}</span>
          </div>
        ) : state === 'failed' ? (
          <div className="flex size-full flex-col items-center justify-center gap-1 p-3 text-center">
            <AlertTriangle aria-hidden className="size-5 text-studio-danger" />
            <span className="text-small">Failed</span>
            {(job?.error || gen?.note) && <span className="line-clamp-2 text-small text-studio-muted">{job?.error ?? gen?.note}</span>}
          </div>
        ) : (
          <button
            type="button"
            onClick={onWave}
            disabled={!src}
            aria-label={`${track.playing ? 'Pause' : 'Play'} ${alt}`}
            aria-describedby={`${uid}-wave`}
            className="absolute inset-0 block size-full disabled:cursor-not-allowed"
          >
            {wave ? (
              <img src={wave} alt="" loading="lazy" decoding="async" className="size-full object-fill px-2 py-3" />
            ) : (
              <AudioLines aria-hidden className="mx-auto size-8 text-studio-muted" />
            )}
            <span
              aria-hidden
              data-testid="play-progress"
              className={cn('pointer-events-none absolute inset-y-0 left-0 bg-studio-accent/15', pct > 0 && 'border-r-2 border-studio-accent')}
              style={{ width: `${pct}%` }}
            />
            <span aria-hidden className="pointer-events-none absolute bottom-2 left-2 flex size-9 items-center justify-center rounded-full bg-studio-accent text-studio-accent-fg shadow-card">
              {track.playing ? <Pause className="size-4" /> : <Play className="size-4 translate-x-px" />}
            </span>
            <span id={`${uid}-wave`} className="sr-only">
              Waveform, {length ? clock(length) : 'length unknown'}
            </span>
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
              'absolute left-1.5 top-1.5 z-10 flex size-6 items-center justify-center rounded-full border-2 border-studio-border-strong transition-opacity duration-150',
              select.selected ? 'bg-studio-accent text-studio-accent-fg' : 'bg-studio-raised text-transparent',
              select.selected || select.active ? 'opacity-100' : 'opacity-0 group-hover/tile:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100',
            )}
          >
            <Check aria-hidden className="size-3.5" />
          </button>
        )}
        {fav && state !== 'pending' && (
          <span className={cn('pointer-events-none absolute top-1.5 rounded-full bg-studio-raised p-1 text-studio-accent', select ? 'left-9' : 'left-1.5')}>
            <Heart aria-hidden className="size-3 fill-current" />
            <span className="sr-only">Favourite</span>
          </span>
        )}
        {state === 'ready' && length ? (
          <span aria-hidden className="pointer-events-none absolute bottom-2 right-2 rounded-[4px] border border-studio-border bg-studio-raised/90 px-1.5 font-mono text-[11px]">
            {track.mine && track.time ? `${clock(track.time)} / ` : ''}
            {clock(length)}
          </span>
        ) : null}
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
      {/* no picture to recognise a track by, so the title is always there, and opens the player */}
      <button type="button" onClick={() => handlers.open(item)} disabled={state !== 'ready'} aria-label={`Open ${alt}`} className="truncate px-0.5 text-left text-small font-medium hover:underline disabled:no-underline" title={alt}>
        {alt}
      </button>
      <div className="flex min-w-0 items-center gap-1.5 px-0.5 text-[11px] text-studio-muted">
        {used ? (
          licence ? (
            <Tooltip content={licence}>
              {/* licensed names are shown whole, never truncated */}
              <span tabIndex={0} className="shrink-0 rounded-[4px] border border-studio-border px-1 leading-4 text-studio-text">
                <span className="sr-only">Made with </span>
                {used}
                <span className="sr-only">. {licence}</span>
              </span>
            </Tooltip>
          ) : (
            <span className="truncate" title={`Made with ${used}`}>
              <span className="sr-only">Made with </span>
              {used}
            </span>
          )
        ) : (
          <span className="truncate">{item.origin === 'upload' ? 'Upload' : ''}</span>
        )}
        {length ? <span className="ml-auto shrink-0 font-mono">{clock(length)}</span> : null}
      </div>
    </div>
  )
}
