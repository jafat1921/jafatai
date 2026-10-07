import { useNavigate } from 'react-router'
import { Brush, ChevronDown, Download, Expand, ImageUpscale, Maximize2, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { downloadUrl, mediaAlt } from '@/lib/media'
import type { TileState } from '@/lib/images'
import type { MediaItem, RegenerateMode } from '@/lib/types'

export interface MediaHandlers {
  open: (item: MediaItem) => void
  regenerate: (item: MediaItem, mode: RegenerateMode) => void
  upscale: (item: MediaItem) => void
  remove: (item: MediaItem) => void
}

/** The review-bar actions for one library tile. Buttons that can't apply to the item aren't shown. */
export function MediaActions({ item, state, handlers }: { item: MediaItem; state: TileState; handlers: MediaHandlers }) {
  const navigate = useNavigate()
  const name = mediaAlt(item)
  const ready = state === 'ready'
  const canRegenerate = item.kind === 'image' && item.origin === 'generated' && state !== 'pending'

  return (
    <div role="group" aria-label={`Actions for ${name}`} className="flex flex-wrap items-center gap-0.5">
      {canRegenerate && (
        <div className="inline-flex">
          <Button
            size="icon-sm"
            variant="secondary"
            className="rounded-r-none"
            onClick={() => handlers.regenerate(item, 'same')}
            aria-label={`${state === 'failed' ? 'Retry' : 'Regenerate'} ${name}`}
            title="Regenerate: same prompt, new seed"
          >
            <RefreshCw aria-hidden />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="secondary" className="rounded-l-none border-l-0" aria-label={`More regenerate options for ${name}`}>
                <ChevronDown aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => handlers.regenerate(item, 'same')}>Same prompt, new seed</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => handlers.regenerate(item, 'note')}>With note…</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => handlers.regenerate(item, 'edit')}>Edit prompt &amp; regenerate…</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      {item.kind === 'image' && ready && (
        <Button size="icon-sm" variant="ghost" aria-label={`Edit ${name}`} title="Edit with words" onClick={() => navigate(`/image/edit?sources=${item.id}`)}>
          <Brush aria-hidden />
        </Button>
      )}
      {ready && (
        <Button size="icon-sm" variant="ghost" aria-label={`Upscale ${name}`} title="Upscale" onClick={() => handlers.upscale(item)}>
          {item.kind === 'image' ? <ImageUpscale aria-hidden /> : <Maximize2 aria-hidden />}
        </Button>
      )}
      {ready && (
        <Button asChild size="icon-sm" variant="ghost" title="Download">
          <a href={downloadUrl(item.generation_id)} download aria-label={`Download ${name}`}>
            <Download aria-hidden />
          </a>
        </Button>
      )}
      {item.origin !== 'project' && state !== 'pending' && (
        <Button size="icon-sm" variant="ghost" aria-label={`Delete ${name}`} title="Delete" onClick={() => handlers.remove(item)}>
          <Trash2 aria-hidden />
        </Button>
      )}
      <Button size="icon-sm" variant="ghost" className="ml-auto" onClick={() => handlers.open(item)} aria-label={`Open ${name}`} title="Open: versions, compare, details">
        <Expand aria-hidden />
      </Button>
    </div>
  )
}
