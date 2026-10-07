import { Brush, Clapperboard, Download, Heart, ImageUpscale, Layers, Maximize2, MoreHorizontal, PanelRightOpen, RefreshCw, Trash2 } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { TileState } from '@/lib/images'
import { downloadUrl, mediaAlt } from '@/lib/media'
import type { MediaItem, RegenerateMode } from '@/lib/types'
import { cn } from '@/lib/utils'

export interface TileHandlers {
  open: (item: MediaItem) => void
  details: (item: MediaItem) => void
  regenerate: (item: MediaItem, mode: RegenerateMode) => void
  upscale: (item: MediaItem) => void
  remove: (item: MediaItem) => void
  edit: (item: MediaItem) => void
  animate: (item: MediaItem) => void
  onUseAsRef: (item: MediaItem) => void
  favourite: (item: MediaItem) => void
  reuse: (item: MediaItem) => void
  // the label for "Use as reference" on this page ("Use as start frame"…)
  refLabel: string
}

const BTN =
  'inline-flex size-7 items-center justify-center rounded-[6px] bg-studio-darkroom/75 text-studio-on-dark backdrop-blur-sm transition-colors duration-150 hover:bg-studio-darkroom [&_svg]:size-3.5'

/** Hover actions on a result: Upscale · Edit · Animate · Use as reference · ♥ · Download · more. */
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
  const canDelete = item.origin !== 'project'

  return (
    <div role="group" aria-label={`Actions for ${name}`} className={cn('flex flex-wrap items-center gap-1', className)}>
      {state === 'failed' && canRegenerate && (
        <button type="button" className={cn(BTN, 'w-auto gap-1 px-2 text-small')} onClick={() => h.regenerate(item, 'same')} aria-label={`Retry ${name}`}>
          <RefreshCw aria-hidden />
          Retry
        </button>
      )}
      {ready && (
        <button type="button" className={BTN} onClick={() => h.upscale(item)} aria-label={`Upscale ${name}`} title="Upscale">
          {image ? <ImageUpscale aria-hidden /> : <Maximize2 aria-hidden />}
        </button>
      )}
      {ready && image && (
        <button type="button" className={BTN} onClick={() => h.edit(item)} aria-label={`Edit ${name}`} title="Edit with words">
          <Brush aria-hidden />
        </button>
      )}
      {ready && image && (
        <button type="button" className={BTN} onClick={() => h.animate(item)} aria-label={`Animate ${name}`} title="Animate (Image to Video)">
          <Clapperboard aria-hidden />
        </button>
      )}
      {ready && image && (
        <button type="button" className={BTN} onClick={() => h.onUseAsRef(item)} aria-label={`${h.refLabel}: ${name}`} title={h.refLabel}>
          <Layers aria-hidden />
        </button>
      )}
      {ready && (
        <button
          type="button"
          className={cn(BTN, fav && 'ring-1 ring-studio-gold')}
          onClick={() => h.favourite(item)}
          aria-pressed={fav}
          aria-label={`Favourite ${name}`}
          title={fav ? 'Remove from favourites' : 'Favourite'}
        >
          <Heart aria-hidden className={cn(fav && 'fill-current')} />
        </button>
      )}
      {ready && (
        <a href={downloadUrl(item.generation_id)} download className={BTN} aria-label={`Download ${name}`} title="Download">
          <Download aria-hidden />
        </a>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger className={BTN} aria-label={`More for ${name}`} title="More">
          <MoreHorizontal aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canRegenerate && (
            <>
              <DropdownMenuItem onSelect={() => h.regenerate(item, 'same')}>
                <RefreshCw aria-hidden />
                Regenerate: same prompt, new seed
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => h.regenerate(item, 'note')}>Regenerate with note…</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => h.regenerate(item, 'edit')}>Edit prompt &amp; regenerate…</DropdownMenuItem>
            </>
          )}
          <DropdownMenuItem onSelect={() => h.details(item)}>
            <PanelRightOpen aria-hidden />
            Versions &amp; details
          </DropdownMenuItem>
          {canDelete && (
            <DropdownMenuItem onSelect={() => h.remove(item)} className="text-studio-danger">
              <Trash2 aria-hidden />
              Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
