import { Link } from 'react-router'
import { Box, Camera, Download, ExternalLink, Film, Heart, ImageIcon, Library, MoreHorizontal, Pencil, RefreshCw, Shuffle, Trash2 } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { downloadUrl, mediaAlt } from '@/lib/media'
import { isModelReady, otherEngine, sourcePictureOf } from '@/lib/model3d'
import type { MediaItem } from '@/lib/types'
import { cn } from '@/lib/utils'
import type { ExportFormat } from './exporters'
import type { ModelHandlers } from './useModelActions'

const FORMATS: { format: ExportFormat; label: string }[] = [
  { format: 'obj', label: 'OBJ' },
  { format: 'stl', label: 'STL' },
  { format: 'usdz', label: 'USDZ' },
]
const ENGINE_LABEL = { pixal3d: 'Pixal3D', trellis2: 'TRELLIS.2' } as const

/** The "⋯" menu on a model tile and on the open model: the whole action list in one keyboard-reachable place. */
export function ModelMenu({ item, h, inViewer, triggerClassName }: { item: MediaItem; h: ModelHandlers; inViewer?: boolean; triggerClassName?: string }) {
  const name = mediaAlt(item)
  const ready = isModelReady(item) && !!item.media_url
  const other = otherEngine(item)
  const source = sourcePictureOf(item)
  const fav = h.isFavourite(item)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label={`More for ${name}`} title="More" className={triggerClassName}>
        <MoreHorizontal aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {ready && !inViewer && h.open && (
          <DropdownMenuItem onSelect={() => h.open!(item)}>
            <Box aria-hidden />
            Open in the viewer
          </DropdownMenuItem>
        )}
        {ready && (
          <>
            <DropdownMenuLabel>Download</DropdownMenuLabel>
            <DropdownMenuItem asChild>
              <a href={downloadUrl(item.generation_id)} download>
                <Download aria-hidden />
                GLB (the original)
              </a>
            </DropdownMenuItem>
            {FORMATS.map((f) => (
              <DropdownMenuItem key={f.format} disabled={!!h.busy} onSelect={() => h.exportAs(item, f.format)}>
                <Download aria-hidden />
                {f.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            {h.turntable && (
              <DropdownMenuItem onSelect={() => h.turntable!(item)}>
                <Film aria-hidden />
                Make turntable
              </DropdownMenuItem>
            )}
            {h.thumbnail && (
              <DropdownMenuItem onSelect={() => h.thumbnail!(item)}>
                <ImageIcon aria-hidden />
                {inViewer ? 'Use this view as thumbnail' : 'Use the front view as thumbnail'}
              </DropdownMenuItem>
            )}
            {h.shots && (
              <DropdownMenuItem onSelect={() => h.shots!(item)}>
                <Camera aria-hidden />
                Product shots for adverts
              </DropdownMenuItem>
            )}
          </>
        )}
        {item.status !== 'queued' && item.status !== 'generating' && (
          <>
            <DropdownMenuItem onSelect={() => h.remake(item)}>
              <RefreshCw aria-hidden />
              Make again
            </DropdownMenuItem>
            {other && (
              <DropdownMenuItem onSelect={() => h.remake(item, other)}>
                <Shuffle aria-hidden />
                Try {ENGINE_LABEL[other]}
              </DropdownMenuItem>
            )}
          </>
        )}
        <DropdownMenuSeparator />
        {source && (
          <DropdownMenuItem asChild>
            <Link to={`/image/library?open=${encodeURIComponent(source)}`}>
              <ExternalLink aria-hidden />
              Show the source picture
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <Link to={`/3d/library?open=${encodeURIComponent(item.id)}`}>
            <Library aria-hidden />
            Open in Library
          </Link>
        </DropdownMenuItem>
        {ready && (
          <DropdownMenuItem onSelect={() => h.favourite(item)}>
            <Heart aria-hidden className={cn(fav && 'fill-current')} />
            {fav ? 'Remove from favourites' : 'Favourite'}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => h.rename(item)}>
          <Pencil aria-hidden />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => h.remove(item)} className="text-studio-danger">
          <Trash2 aria-hidden />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
