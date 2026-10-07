import { useState } from 'react'
import { ImagePlus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { MediaPicker } from '@/components/media/MediaPicker'
import { UploadZone } from '@/components/media/UploadZone'
import { useMediaItem } from '@/hooks/useMedia'
import { mediaAlt } from '@/lib/media'

/** Optional first frame for the clip: pick from the library or upload one. */
export function StartImage({ id, onChange }: { id: string | null; onChange: (id: string | null) => void }) {
  const [picking, setPicking] = useState(false)
  const item = useMediaItem(id)
  const m = item.data

  return (
    <div className="flex flex-col gap-2" role="group" aria-labelledby="start-image-label">
      <div className="flex items-center justify-between gap-2">
        <span id="start-image-label" className="section-label">
          Start image (optional)
        </span>
        <Button type="button" size="sm" variant="secondary" onClick={() => setPicking(true)}>
          <ImagePlus aria-hidden />
          {id ? 'Change' : 'Pick from library'}
        </Button>
      </div>
      {id ? (
        <div className="relative w-48">
          {m ? (
            <figure className="darkroom aspect-video overflow-hidden rounded-[6px]">
              {m.thumb_url || m.media_url ? (
                <img src={m.thumb_url ?? m.media_url!} alt={mediaAlt(m)} className="size-full object-cover" />
              ) : (
                <span className="flex size-full items-center justify-center text-small">{mediaAlt(m)}</span>
              )}
            </figure>
          ) : item.isError ? (
            <p className="darkroom flex aspect-video items-center justify-center rounded-[6px] p-2 text-center text-small">Couldn't load this image</p>
          ) : (
            <Skeleton className="aspect-video" />
          )}
          <Button
            type="button"
            size="icon-sm"
            variant="secondary"
            className="absolute right-1.5 top-1.5"
            aria-label="Remove the start image"
            onClick={() => onChange(null)}
          >
            <X aria-hidden />
          </Button>
        </div>
      ) : (
        <UploadZone compact multiple={false} kinds={['image']} onUploaded={(u) => onChange(u.id)} />
      )}
      <MediaPicker
        open={picking}
        onOpenChange={setPicking}
        kind="image"
        max={1}
        title="Pick a start image"
        description="The clip opens on this frame and moves from there."
        onConfirm={(items) => items[0] && onChange(items[0].id)}
      />
    </div>
  )
}
