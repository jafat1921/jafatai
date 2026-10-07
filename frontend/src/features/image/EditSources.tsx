import { useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import { ImagePlus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { MediaPicker } from '@/components/media/MediaPicker'
import { UploadZone } from '@/components/media/UploadZone'
import { qk } from '@/hooks/keys'
import { api } from '@/lib/api'
import { MAX_EDIT_SOURCES } from '@/lib/images'
import { mediaAlt } from '@/lib/media'
import type { MediaItem } from '@/lib/types'

interface Props {
  ids: string[]
  onAdd: (items: MediaItem[]) => void
  onRemove: (id: string) => void
  notice?: string | null
}

/** The 1–3 reference images an edit works from: library picks, uploads, or ids from the URL. */
export function EditSources({ ids, onAdd, onRemove, notice }: Props) {
  const [picking, setPicking] = useState(false)
  const items = useQueries({
    queries: ids.map((id) => ({ queryKey: qk.mediaItem(id), queryFn: () => api.media.get(id) })),
  })
  const full = ids.length >= MAX_EDIT_SOURCES

  return (
    <div className="flex flex-col gap-2" role="group" aria-labelledby="edit-sources-label">
      <div className="flex items-center justify-between gap-2">
        <span id="edit-sources-label" className="section-label">
          Source images ({ids.length}/{MAX_EDIT_SOURCES})
        </span>
        <Button type="button" size="sm" variant="secondary" disabled={full} onClick={() => setPicking(true)}>
          <ImagePlus aria-hidden />
          Add from library
        </Button>
      </div>
      {ids.length > 0 && (
        <ul className="grid grid-cols-3 gap-3" aria-label="Chosen sources">
          {ids.map((id, i) => {
            const q = items[i]
            const m = q?.data
            return (
              <li key={id} className="relative">
                {m ? (
                  <figure className="darkroom aspect-square overflow-hidden rounded-[6px]">
                    {m.media_url || m.thumb_url ? (
                      <img src={m.thumb_url ?? m.media_url!} alt={mediaAlt(m)} className="size-full object-cover" />
                    ) : (
                      <span className="flex size-full items-center justify-center text-small">{mediaAlt(m)}</span>
                    )}
                  </figure>
                ) : q?.isError ? (
                  <p className="darkroom flex aspect-square items-center justify-center rounded-[6px] p-2 text-center text-small">Couldn't load this image</p>
                ) : (
                  <Skeleton className="aspect-square" />
                )}
                <Button
                  type="button"
                  size="icon-sm"
                  variant="secondary"
                  className="absolute right-1.5 top-1.5"
                  aria-label={`Remove ${m ? mediaAlt(m) : 'source'}`}
                  onClick={() => onRemove(id)}
                >
                  <X aria-hidden />
                </Button>
                <span className="mt-1 block text-small text-studio-muted">Reference {i + 1}</span>
              </li>
            )
          })}
        </ul>
      )}
      {!full && <UploadZone compact kinds={['image']} onUploaded={(m) => onAdd([m])} />}
      {notice && (
        <p className="text-small text-studio-warning" role="status">
          {notice}
        </p>
      )}
      <MediaPicker
        open={picking}
        onOpenChange={setPicking}
        kind="image"
        max={MAX_EDIT_SOURCES}
        taken={ids}
        title="Pick source images"
        description="Faces, products or styles to work from."
        onConfirm={onAdd}
      />
    </div>
  )
}
