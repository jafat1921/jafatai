import { useId, useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useMediaItem } from '@/hooks/useMedia'
import type { BrandPurpose } from '@/lib/brand'
import { mediaAlt } from '@/lib/media'
import type { MediaItem } from '@/lib/types'
import { cn } from '@/lib/utils'
import { SourceDropZone } from './SourceDropZone'

interface Props {
  label: string
  value: string | null
  onChange: (id: string | null, item?: MediaItem) => void
  purpose?: BrandPurpose
  // brand kits already know each asset's URL; skips the media lookup
  previewUrl?: string | null
  required?: boolean
  hint?: React.ReactNode
  aspectClass?: string
  removeLabel?: string
  globalPaste?: boolean
  pickDescription?: string
  // see-through logos read better on a checkerboard than in the darkroom
  checker?: boolean
  className?: string
}

/** One image slot: empty it's a drop/paste/pick zone, filled it's a thumbnail with Replace and Remove. */
export function ImageSourceField({
  label,
  value,
  onChange,
  purpose,
  previewUrl,
  required,
  hint,
  aspectClass = 'aspect-video',
  removeLabel,
  globalPaste,
  pickDescription,
  checker,
  className,
}: Props) {
  const uid = useId()
  const [replacing, setReplacing] = useState(false)
  const [local, setLocal] = useState<MediaItem | null>(null)
  // e.g. "this logo has no transparency"; kept for as long as that upload is the one shown
  const [warned, setWarned] = useState<{ id: string; text: string[] } | null>(null)
  const warnings = warned?.id === value ? warned.text : []
  const filled = !!value && !replacing
  const known = local?.id === value ? local : null
  const fetched = useMediaItem(previewUrl || known ? null : value)
  const item = known ?? fetched.data
  const src = previewUrl ?? item?.thumb_url ?? item?.media_url
  const alt = item ? mediaAlt(item) : label

  const take = (items: MediaItem[], warnings: string[]) => {
    const m = items[0]
    if (!m) return
    setLocal(m)
    setWarned({ id: m.id, text: warnings })
    setReplacing(false)
    onChange(m.id, m)
  }

  return (
    <div className={cn('flex flex-col gap-2', className)} role="group" aria-labelledby={`${uid}-label`}>
      <div className="flex items-baseline justify-between gap-2">
        <span id={`${uid}-label`} className="section-label">
          {label}
          {required ? '' : ' (optional)'}
        </span>
      </div>
      {hint && <p className="-mt-1 text-small text-studio-muted">{hint}</p>}
      {filled ? (
        <div className="flex items-start gap-2">
          <figure
            className={cn(
              'relative w-48 max-w-full overflow-hidden rounded-[6px]',
              checker ? 'checker border border-studio-border-strong' : 'darkroom',
              aspectClass,
            )}
          >
            {src ? (
              <img src={src} alt={alt} className={cn('size-full', checker ? 'object-contain p-2' : 'object-cover')} />
            ) : fetched.isError ? (
              <span className="flex size-full items-center justify-center p-2 text-center text-small">Couldn't load this image</span>
            ) : (
              <Skeleton className="size-full" />
            )}
          </figure>
          <div className="flex flex-col gap-1.5">
            <Button type="button" size="sm" variant="secondary" onClick={() => setReplacing(true)}>
              <RefreshCw aria-hidden />
              Replace
            </Button>
            <Button type="button" size="sm" variant="ghost" aria-label={removeLabel ?? `Remove ${label.toLowerCase()}`} onClick={() => onChange(null)}>
              <X aria-hidden />
              Remove
            </Button>
          </div>
        </div>
      ) : null}
      {filled && warnings.length > 0 && (
        <p role="status" className="text-small text-studio-warning">
          {warnings.join(' ')}
        </p>
      )}
      {!filled && (
        <>
          <SourceDropZone
            label={`Add ${label.toLowerCase()}`}
            pickTitle={`Pick ${label.toLowerCase()}`}
            purpose={purpose}
            onAdd={take}
            globalPaste={globalPaste}
            pickDescription={pickDescription}
          />
          {replacing && (
            <Button type="button" size="sm" variant="ghost" className="self-start" onClick={() => setReplacing(false)}>
              Keep the current image
            </Button>
          )}
        </>
      )}
    </div>
  )
}
