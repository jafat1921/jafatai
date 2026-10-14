import { RefAdd, RefThumb } from '@/components/generate/RefSlot'
import { MAX_EDIT_SOURCES } from '@/lib/images'
import type { MediaItem } from '@/lib/types'

interface Props {
  // in slot order; '' is an empty labelled slot
  ids: string[]
  onAdd: (items: MediaItem[], at?: number) => void
  onRemove: (id: string) => void
  notice?: string | null
  // from the chosen model's max_refs
  max?: number
  // from an edit template: what each picture is ("Person", "Garment"), and how many must be there
  labels?: string[]
  required?: number
}

const listOf = (words: string[]) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`)

/** The reference images (up to the model's max_refs) an edit works from, as a compact tray in the dock. */
export function EditSources({ ids, onAdd, onRemove, notice, max = MAX_EDIT_SOURCES, labels = [], required = 0 }: Props) {
  const filled = ids.filter(Boolean)
  const full = filled.length >= max
  if (labels.length) return <LabelledSources {...{ ids, onAdd, onRemove, notice, max, labels, required }} />
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-labelledby="edit-sources-label">
      <span id="edit-sources-label" className="section-label">
        Source images ({filled.length}/{max})
      </span>
      <div className="flex flex-wrap items-start gap-2">
        {filled.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label="Chosen sources">
            {filled.map((id, i) => (
              <li key={id}>
                <RefThumb id={id} label={`Reference ${i + 1}`} onRemove={() => onRemove(id)} />
              </li>
            ))}
          </ul>
        )}
        {!full && (
          <RefAdd
            label={filled.length ? 'Another source' : 'Source image'}
            required={!filled.length}
            multiple
            max={max - filled.length}
            taken={filled}
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

// One slot per label, in the order the instruction talks about them ("image 1", "image 2")
function LabelledSources({ ids, onAdd, onRemove, notice, max, labels, required }: Required<Omit<Props, 'notice'>> & { notice?: string | null }) {
  const filled = ids.filter(Boolean)
  const extras = ids.slice(labels.length).filter(Boolean)
  const roomForExtra = filled.length < max && labels.every((_, i) => ids[i]) && labels.length < max
  const order = listOf(labels.map((l, i) => `image ${i + 1} is the ${l.toLowerCase()}`))
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-labelledby="edit-sources-label" aria-describedby="edit-sources-order">
      <span id="edit-sources-label" className="section-label">
        Pictures for this template ({filled.length}/{max})
      </span>
      <p id="edit-sources-order" className="text-small text-studio-muted">
        {order[0].toUpperCase() + order.slice(1)}.
      </p>
      <ul className="flex flex-wrap items-start gap-2" aria-label="Template pictures">
        {labels.map((label, i) => (
          <li key={label + i}>
            {ids[i] ? (
              <RefThumb id={ids[i]} label={label} removeLabel={`Remove the ${label.toLowerCase()} picture`} onRemove={() => onRemove(ids[i])} />
            ) : (
              <RefAdd
                label={label}
                required={i < required}
                taken={filled}
                description={`The ${label.toLowerCase()} picture (image ${i + 1}).`}
                onAdd={(items) => onAdd(items.slice(0, 1), i)}
              />
            )}
          </li>
        ))}
        {extras.map((id, i) => (
          <li key={id}>
            <RefThumb id={id} label={`Reference ${labels.length + i + 1}`} onRemove={() => onRemove(id)} />
          </li>
        ))}
        {roomForExtra && (
          <li>
            <RefAdd label="Extra (optional)" taken={filled} description="Another picture to work from." onAdd={(items) => onAdd(items.slice(0, 1))} />
          </li>
        )}
      </ul>
      {notice && (
        <p className="text-small text-studio-warning" role="status">
          {notice}
        </p>
      )}
    </div>
  )
}
