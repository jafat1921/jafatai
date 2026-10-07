import { useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SourceDropZone } from '@/components/media/SourceDropZone'
import { qk } from '@/hooks/keys'
import { api } from '@/lib/api'
import { addRefs, MAX_REFS } from '@/lib/brand'
import { EditorSection, type AssetUrls } from './EditorSection'

export function MoodRefsSection({ ids, urls, onChange }: { ids: string[]; urls: AssetUrls; onChange: (ids: string[]) => void }) {
  const [notice, setNotice] = useState<string | null>(null)
  // only look up the ones the kit can't show yet (fresh picks and uploads)
  const lookups = useQueries({
    queries: ids.map((id) => ({ queryKey: qk.mediaItem(id), queryFn: () => api.media.get(id), enabled: !urls[id] })),
  })
  const full = ids.length >= MAX_REFS

  return (
    <EditorSection
      title={`Mood references (${ids.length}/${MAX_REFS})`}
      hint="Pictures with the look you want: light, colour, framing. They guide the style; they aren't copied."
    >
      {ids.length > 0 && (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-6" aria-label="Mood references">
          {ids.map((id, i) => {
            const m = lookups[i]?.data
            const src = urls[id] ?? m?.thumb_url ?? m?.media_url
            return (
              <li key={id} className="relative">
                <figure className="darkroom aspect-square overflow-hidden rounded-[6px]">
                  {src ? <img src={src} alt={m?.title || `Mood reference ${i + 1}`} className="size-full object-cover" /> : null}
                </figure>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="secondary"
                  className="absolute right-1 top-1"
                  aria-label={`Remove mood reference ${i + 1}`}
                  onClick={() => {
                    onChange(ids.filter((x) => x !== id))
                    setNotice(null)
                  }}
                >
                  <X aria-hidden />
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      {!full && (
        <SourceDropZone
          label="Add mood references"
          purpose="reference"
          multiple
          pickMax={MAX_REFS - ids.length}
          taken={ids}
          onAdd={(items) => {
            const next = addRefs(ids, items.map((m) => m.id))
            onChange(next.ids)
            setNotice(next.dropped ? `A kit holds ${MAX_REFS} references, so ${next.dropped} weren't added.` : null)
          }}
        />
      )}
      {notice && (
        <p role="status" className="text-small text-studio-warning">
          {notice}
        </p>
      )}
    </EditorSection>
  )
}
