import { useState } from 'react'
import { ImagePlus, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { SourceDropZone } from '@/components/media/SourceDropZone'
import { useMediaItem } from '@/hooks/useMedia'
import { mediaAlt } from '@/lib/media'
import type { MediaItem } from '@/lib/types'
import { cn } from '@/lib/utils'

const BOX = 'relative size-16 shrink-0 overflow-hidden rounded-[6px] md:size-[72px]'

/** A filled reference: a small darkroom thumbnail with a remove button. */
export function RefThumb({ id, label, removeLabel, onRemove }: { id: string; label: string; removeLabel?: string; onRemove: () => void }) {
  const q = useMediaItem(id)
  const m = q.data
  const src = m?.thumb_url ?? m?.media_url
  return (
    <figure className="flex flex-col items-center gap-1">
      <div className={cn(BOX, 'darkroom')}>
        {src ? (
          <img src={src} alt={m ? mediaAlt(m) : label} className="size-full object-cover" />
        ) : q.isError ? (
          <span className="flex size-full items-center justify-center p-1 text-center text-[11px] text-studio-on-dark">Can't load</span>
        ) : (
          <Skeleton className="size-full" />
        )}
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel ?? `Remove ${m ? mediaAlt(m) : label.toLowerCase()}`}
          className="absolute right-0.5 top-0.5 flex size-6 items-center justify-center rounded-full bg-studio-darkroom/80 text-studio-on-dark hover:bg-studio-darkroom"
        >
          <X aria-hidden className="size-3.5" />
        </button>
      </div>
      <figcaption className="max-w-[80px] truncate text-[11px] text-studio-muted">{label}</figcaption>
    </figure>
  )
}

interface AddProps {
  label: string
  onAdd: (items: MediaItem[]) => void
  multiple?: boolean
  max?: number
  taken?: string[]
  required?: boolean
  description?: string
}

/** An empty slot: opens a small upload / paste / pick panel. */
export function RefAdd({ label, onAdd, multiple, max = 1, taken, required, description }: AddProps) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className={cn(
            BOX,
            'flex flex-col items-center justify-center gap-0.5 border border-dashed text-studio-muted hover:bg-studio-panel-hover hover:text-studio-text',
            required ? 'border-studio-accent' : 'border-studio-border-strong',
          )}
          aria-label={`Add ${label.toLowerCase()}${required ? ' (required)' : ''}`}
        >
          <ImagePlus aria-hidden className="size-5" />
        </PopoverTrigger>
        <PopoverContent aria-label={`Add ${label.toLowerCase()}`} className="w-[min(420px,calc(100vw-24px))]">
          <SourceDropZone
            label={`Add ${label.toLowerCase()}`}
            pickTitle={`Pick ${label.toLowerCase()}`}
            pickDescription={description}
            multiple={multiple}
            pickMax={max}
            taken={taken}
            onAdd={(items) => {
              onAdd(items)
              setOpen(false)
            }}
          />
        </PopoverContent>
      </Popover>
      {/* required slots carry an accent border and say so to screen readers */}
      <span className="max-w-[80px] truncate text-[11px] text-studio-muted">{label}</span>
    </div>
  )
}

/** One slot that is either a thumbnail or an add button. */
export function RefSlot({
  label,
  value,
  onChange,
  required,
  removeLabel,
  description,
}: {
  label: string
  value: string | null
  onChange: (id: string | null, item?: MediaItem) => void
  required?: boolean
  removeLabel?: string
  description?: string
}) {
  return value ? (
    <RefThumb id={value} label={label} removeLabel={removeLabel} onRemove={() => onChange(null)} />
  ) : (
    <RefAdd label={label} required={required} description={description} onAdd={(items) => items[0] && onChange(items[0].id, items[0])} />
  )
}
