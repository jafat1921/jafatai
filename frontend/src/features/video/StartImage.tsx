import { ImageSourceField } from '@/components/media/ImageSourceField'

/** The clip's first frame (or, with `end`, its last): upload, paste, drop or pick from the Library. */
export function StartImage({
  id,
  onChange,
  required,
  end,
  globalPaste,
}: {
  id: string | null
  onChange: (id: string | null) => void
  required?: boolean
  end?: boolean
  globalPaste?: boolean
}) {
  return (
    <ImageSourceField
      label={end ? 'End image' : 'Start image'}
      required={required}
      value={id}
      onChange={(v) => onChange(v)}
      removeLabel={end ? 'Remove the end image' : 'Remove the start image'}
      globalPaste={globalPaste}
      pickDescription={end ? 'The clip lands on this frame.' : 'The clip opens on this frame and moves from there.'}
    />
  )
}
