import { ImageOff, Loader2 } from 'lucide-react'
import { BeforeAfter } from '@/components/media/BeforeAfter'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { editLabel } from '@/lib/photo/history'
import type { HistoryVersion } from '@/lib/photo/types'
import { isPendingGeneration } from '@/lib/status'
import { cn } from '@/lib/utils'

/** Versions along the bottom of the canvas, oldest first; click one to edit from it. */
export function Filmstrip({ versions, openedId, onOpen }: { versions: HistoryVersion[]; openedId: string; onOpen: (id: string) => void }) {
  const ordered = [...versions].sort((a, b) => a.generation.version - b.generation.version)
  return (
    <ScrollArea orientation="horizontal" className="w-full">
      <ol className="flex gap-2 px-3 py-2" aria-label="Versions">
        {ordered.map((v) => {
          const g = v.generation
          const pending = isPendingGeneration(g.status)
          const src = g.thumb_url ?? (g.media_type === 'image/tiff' ? null : g.media_url)
          const here = g.id === openedId
          return (
            <li key={g.id} className="shrink-0">
              <button
                type="button"
                disabled={pending || g.status === 'failed'}
                aria-current={here ? 'true' : undefined}
                aria-label={`Version ${g.version}, ${editLabel(v)}${v.current ? ', current' : ''}${pending ? ', rendering' : ''}`}
                onClick={() => onOpen(g.id)}
                className={cn(
                  'darkroom relative block h-14 w-20 overflow-hidden rounded-[4px] border-2 disabled:opacity-60',
                  here ? 'border-studio-gold' : 'border-transparent hover:border-studio-on-dark-muted',
                )}
              >
                {pending ? (
                  <Loader2 aria-hidden className="m-auto size-4 text-studio-on-dark-muted motion-safe:animate-spin" />
                ) : src ? (
                  <img src={src} alt="" className="size-full object-cover" loading="lazy" draggable={false} />
                ) : (
                  <ImageOff aria-hidden className="m-auto size-4 text-studio-on-dark-muted" />
                )}
                <span className="absolute bottom-0 left-0 rounded-tr-[3px] bg-studio-darkroom/85 px-1 font-mono text-[11px] text-studio-on-dark">v{g.version}</span>
              </button>
            </li>
          )
        })}
      </ol>
    </ScrollArea>
  )
}

/** Two versions side by side as a wipe. */
export function CompareDialog({ pair, title, onClose }: { pair: [HistoryVersion, HistoryVersion] | null; title: string; onClose: () => void }) {
  const src = (v: HistoryVersion) => v.generation.media_url ?? v.generation.thumb_url ?? ''
  return (
    <Dialog open={!!pair} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-5xl">
        {pair && (
          <>
            <DialogHeader>
              <DialogTitle>Compare v{pair[0].generation.version} and v{pair[1].generation.version}</DialogTitle>
              <DialogDescription>Drag the divider, or focus it and use the arrow keys. L shows a 1:1 loupe.</DialogDescription>
            </DialogHeader>
            <BeforeAfter
              before={src(pair[0])}
              after={src(pair[1])}
              alt={title}
              beforeLabel={`v${pair[0].generation.version} · ${editLabel(pair[0])}`}
              afterLabel={`v${pair[1].generation.version} · ${editLabel(pair[1])}`}
              aspectClass="h-[65vh]"
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
