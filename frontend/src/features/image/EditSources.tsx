import { RefAdd, RefThumb } from '@/components/generate/RefSlot'
import { MAX_EDIT_SOURCES } from '@/lib/images'
import type { MediaItem } from '@/lib/types'

interface Props {
  ids: string[]
  onAdd: (items: MediaItem[]) => void
  onRemove: (id: string) => void
  notice?: string | null
  // from the chosen model's max_refs
  max?: number
}

/** The reference images (up to the model's max_refs) an edit works from, as a compact tray in the dock. */
export function EditSources({ ids, onAdd, onRemove, notice, max = MAX_EDIT_SOURCES }: Props) {
  const full = ids.length >= max
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-labelledby="edit-sources-label">
      <span id="edit-sources-label" className="section-label">
        Source images ({ids.length}/{max})
      </span>
      <div className="flex flex-wrap items-start gap-2">
        {ids.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label="Chosen sources">
            {ids.map((id, i) => (
              <li key={id}>
                <RefThumb id={id} label={`Reference ${i + 1}`} onRemove={() => onRemove(id)} />
              </li>
            ))}
          </ul>
        )}
        {!full && (
          <RefAdd
            label={ids.length ? 'Another source' : 'Source image'}
            required={!ids.length}
            multiple
            max={max - ids.length}
            taken={ids}
            description="Faces, products or styles to work from."
            onAdd={onAdd}
          />
        )}
      </div>
      {notice && (
        <p className="text-small text-studio-warning" role="status">
          {notice}
        </p>
      )}
    </div>
  )
}
