import { Brush, Clapperboard, Download, Heart, ImageUpscale, Layers, Maximize2, RefreshCw } from 'lucide-react'
import type { TileState } from '@/lib/images'
import { downloadUrl, mediaAlt } from '@/lib/media'
import type { MediaItem } from '@/lib/types'
import { cn } from '@/lib/utils'
import { TileMenu, type TileHandlers } from './TileMenu'

export type { TileHandlers } from './TileMenu'

export const TILE_BTN =
  'inline-flex size-7 items-center justify-center rounded-[6px] bg-studio-darkroom/75 text-studio-on-dark backdrop-blur-sm transition-colors duration-150 hover:bg-studio-darkroom [&_svg]:size-3.5'

/** Hover actions on a result: Upscale · Edit · Animate · Use as reference · ♥ · Download · ⋯ (the full menu). */
export function TileActions({
  item,
  state,
  handlers: h,
  fav,
  className,
}: {
  item: MediaItem
  state: TileState
  handlers: TileHandlers
  fav: boolean
  className?: string
}) {
  const name = mediaAlt(item)
  const ready = state === 'ready'
  const image = item.kind === 'image'
  const canRegenerate = image && item.origin === 'generated'

  return (
    <div role="group" aria-label={`Actions for ${name}`} className={cn('flex flex-wrap items-center gap-1', className)}>
      {state === 'failed' && canRegenerate && (
        <button type="button" className={cn(TILE_BTN, 'w-auto gap-1 px-2 text-small')} onClick={() => h.regenerate(item, 'same')} aria-label={`Retry ${name}`}>
          <RefreshCw aria-hidden />
          Retry
        </button>
      )}
      {ready && (
        <button type="button" className={TILE_BTN} onClick={() => h.upscale(item)} aria-label={`Upscale ${name}`} title="Upscale">
          {image ? <ImageUpscale aria-hidden /> : <Maximize2 aria-hidden />}
        </button>
      )}
      {ready && image && (
        <button type="button" className={TILE_BTN} onClick={() => h.edit(item)} aria-label={`Edit ${name}`} title="Edit with words">
          <Brush aria-hidden />
        </button>
      )}
      {ready && image && (
        <button type="button" className={TILE_BTN} onClick={() => h.animate(item)} aria-label={`Animate ${name}`} title="Animate (Image to Video)">
          <Clapperboard aria-hidden />
        </button>
      )}
      {ready && image && (
        <button type="button" className={TILE_BTN} onClick={() => h.onUseAsRef(item)} aria-label={`${h.refLabel}: ${name}`} title={h.refLabel}>
          <Layers aria-hidden />
        </button>
      )}
      {ready && (
        <button
          type="button"
          className={cn(TILE_BTN, fav && 'ring-1 ring-studio-gold')}
          onClick={() => h.favourite(item)}
          aria-pressed={fav}
          aria-label={`Favourite ${name}`}
          title={fav ? 'Remove from favourites' : 'Favourite'}
        >
          <Heart aria-hidden className={cn(fav && 'fill-current')} />
        </button>
      )}
      {ready && (
        <a href={downloadUrl(item.generation_id)} download className={TILE_BTN} aria-label={`Download ${name}`} title="Download">
          <Download aria-hidden />
        </a>
      )}
      <TileMenu item={item} state={state} handlers={h} fav={fav} triggerClassName={TILE_BTN} />
    </div>
  )
}
