import { Check, Clapperboard, Download, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { api } from '@/lib/api'
import type { Look } from '@/lib/photo/types'
import { cn } from '@/lib/utils'

const SOURCE: Record<Look['source'], string> = { builtin: 'Built-in', user: 'Yours', imported: 'Imported' }

interface Props {
  look: Look
  thumb: string
  applied: boolean
  onApply: () => void
  onVideo: () => void
  onRename: () => void
  onDelete: () => void
}

export function LookCard({ look, thumb, applied, onApply, onVideo, onRename, onDelete }: Props) {
  return (
    <li className="group/look relative flex flex-col gap-1">
      <button
        type="button"
        onClick={onApply}
        aria-pressed={applied}
        aria-label={`Apply look ${look.name}`}
        className={cn('darkroom relative aspect-square overflow-hidden rounded-[6px] p-0', applied && 'ring-2 ring-studio-accent ring-offset-1 ring-offset-studio-panel')}
      >
        <img src={thumb} alt="" loading="lazy" className="size-full object-cover" draggable={false} />
        {applied && (
          <span className="absolute left-1 top-1 flex size-5 items-center justify-center rounded-full bg-studio-accent text-studio-accent-fg">
            <Check aria-hidden className="size-3" />
          </span>
        )}
        {look.has_cube && <span className="absolute bottom-1 left-1 rounded-[3px] bg-studio-darkroom/85 px-1 font-mono text-[11px] text-studio-on-dark">LUT</span>}
      </button>
      <div className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-small font-medium" title={look.description ?? look.name}>
          {look.name}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger className="rounded-[4px] p-0.5 text-studio-muted hover:bg-studio-panel-hover hover:text-studio-text" aria-label={`More for ${look.name}`}>
            <MoreHorizontal aria-hidden className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onVideo}>
              <Clapperboard aria-hidden />
              Apply to a video…
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href={api.looks.cubeUrl(look.id)} download>
                <Download aria-hidden />
                Export .cube
              </a>
            </DropdownMenuItem>
            {look.editable && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onRename}>
                  <Pencil aria-hidden />
                  Rename…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onDelete} className="text-studio-danger">
                  <Trash2 aria-hidden />
                  Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <span className="text-[11px] text-studio-muted">{look.category ? `${look.category} · ` : ''}{SOURCE[look.source]}</span>
    </li>
  )
}
