import { Link } from 'react-router'
import {
  Aperture, Brush, Clapperboard, Download, ExternalLink, FolderInput, Heart, ImageUpscale, Layers, Maximize2, MoreHorizontal, Palette, PanelRightOpen,
  Pencil, Play, RefreshCw, Trash2,
} from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { TileState } from '@/lib/images'
import { downloadUrl, mediaAlt, projectLink } from '@/lib/media'
import type { MediaItem, RegenerateMode } from '@/lib/types'
import { cn } from '@/lib/utils'

export interface TileHandlers {
  open: (item: MediaItem) => void
  details: (item: MediaItem) => void
  regenerate: (item: MediaItem, mode: RegenerateMode) => void
  upscale: (item: MediaItem) => void
  remove: (item: MediaItem) => void
  edit: (item: MediaItem) => void
  img2img: (item: MediaItem) => void
  animate: (item: MediaItem) => void
  onUseAsRef: (item: MediaItem) => void
  favourite: (item: MediaItem) => void
  move: (item: MediaItem) => void
  rename: (item: MediaItem) => void
  reuse: (item: MediaItem) => void
  // the label for "Use as reference" on this page ("Use as start frame"…)
  refLabel: string
}

// keeps a click on the menu from reaching the tile underneath (select / open)
const stop = (e: React.SyntheticEvent) => e.stopPropagation()

/**
 * The "⋯" menu every media tile carries: the whole action list in one keyboard-reachable place.
 * The hover buttons on Library tiles are shortcuts into the same handlers.
 */
export function TileMenu({
  item,
  state,
  handlers: h,
  fav,
  triggerClassName,
}: {
  item: MediaItem
  state: TileState
  handlers: TileHandlers
  fav: boolean
  triggerClassName?: string
}) {
  const name = mediaAlt(item)
  const ready = state === 'ready'
  const image = item.kind === 'image'
  const project = item.origin === 'project'
  const canRegenerate = image && item.origin === 'generated'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={triggerClassName} aria-label={`More for ${name}`} title="More" onClick={stop} onPointerDown={stop} onKeyDown={stop}>
        <MoreHorizontal aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={stop}>
        {state === 'failed' && canRegenerate && (
          <DropdownMenuItem onSelect={() => h.regenerate(item, 'same')}>
            <RefreshCw aria-hidden />
            Retry
          </DropdownMenuItem>
        )}
        {ready && (
          <DropdownMenuItem onSelect={() => h.open(item)}>
            <Play aria-hidden />
            Open
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => h.details(item)}>
          <PanelRightOpen aria-hidden />
          Versions
        </DropdownMenuItem>
        {ready && (
          <DropdownMenuItem asChild>
            <a href={downloadUrl(item.generation_id)} download>
              <Download aria-hidden />
              Download
            </a>
          </DropdownMenuItem>
        )}
        {ready && item.original_generation_id && item.original_generation_id !== item.generation_id && (
          <DropdownMenuItem asChild>
            <a href={downloadUrl(item.original_generation_id)} download>
              <Download aria-hidden />
              Download original
            </a>
          </DropdownMenuItem>
        )}
        {ready && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => h.upscale(item)}>
              {image ? <ImageUpscale aria-hidden /> : <Maximize2 aria-hidden />}
              Upscale…
            </DropdownMenuItem>
          </>
        )}
        {ready && image && (
          <>
            <DropdownMenuItem asChild>
              <Link to={`/image/studio/${item.generation_id}`}>
                <Aperture aria-hidden />
                Open in Photo Studio
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => h.edit(item)}>
              <Brush aria-hidden />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => h.img2img(item)}>
              <Palette aria-hidden />
              Image to Image
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => h.animate(item)}>
              <Clapperboard aria-hidden />
              Animate → Image to Video
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => h.onUseAsRef(item)}>
              <Layers aria-hidden />
              {h.refLabel}
            </DropdownMenuItem>
          </>
        )}
        {canRegenerate && ready && (
          <>
            <DropdownMenuItem onSelect={() => h.regenerate(item, 'same')}>
              <RefreshCw aria-hidden />
              Regenerate: same prompt, new seed
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => h.regenerate(item, 'note')}>Regenerate with note…</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => h.regenerate(item, 'edit')}>Edit prompt &amp; regenerate…</DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => h.move(item)}>
          <FolderInput aria-hidden />
          Move to folder…
        </DropdownMenuItem>
        {ready && (
          <DropdownMenuItem onSelect={() => h.favourite(item)}>
            <Heart aria-hidden className={cn(fav && 'fill-current')} />
            {fav ? 'Remove from favourites' : 'Favourite'}
          </DropdownMenuItem>
        )}
        {project ? (
          item.project_id && (
            <DropdownMenuItem asChild>
              <Link to={projectLink(item)}>
                <ExternalLink aria-hidden />
                Manage in project
              </Link>
            </DropdownMenuItem>
          )
        ) : (
          <>
            <DropdownMenuItem onSelect={() => h.rename(item)}>
              <Pencil aria-hidden />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => h.remove(item)} className="text-studio-danger">
              <Trash2 aria-hidden />
              Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
