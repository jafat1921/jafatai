import { MapPin, User } from 'lucide-react'
import { useCharacters } from '@/hooks/useCharacters'
import { useLocations } from '@/hooks/useLocations'
import type { Generation, Shot } from '@/lib/types'
import { cn } from '@/lib/utils'

// The server attaches up to 3 references: characters first, then the location (contract v1, Keyframes).
const MAX_REFS = 3

interface Ref {
  key: string
  name: string
  kind: 'character' | 'location'
  image?: Generation | null
}

export function RefsStrip({ shot, sceneLocationId }: { shot: Shot; sceneLocationId?: string | null }) {
  const { data: cast } = useCharacters(shot.project_id)
  const { data: locations } = useLocations(shot.project_id)

  const refs: Ref[] = []
  for (const id of shot.character_ids) {
    const c = cast?.find((x) => x.id === id)
    if (c) refs.push({ key: c.id, name: c.name, kind: 'character', image: c.approved_portrait })
  }
  const locId = shot.location_id ?? sceneLocationId
  const loc = locId ? locations?.find((l) => l.id === locId) : undefined
  if (loc) refs.push({ key: loc.id, name: loc.name, kind: 'location', image: loc.approved_establishing })

  const usable = refs.filter((r) => r.image)
  const used = new Set(usable.slice(0, MAX_REFS).map((r) => r.key))

  return (
    <section aria-labelledby={`refs-${shot.id}`}>
      <h3 id={`refs-${shot.id}`} className="section-label mb-1.5">
        References used
      </h3>
      {refs.length === 0 ? (
        <p className="text-small text-studio-muted">
          No characters or location on this shot, so the frame is drawn from the prompt alone. Add them on the shot row.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {refs.map((r) => {
            const on = used.has(r.key)
            const Icon = r.kind === 'character' ? User : MapPin
            const why = !r.image
              ? r.kind === 'character'
                ? 'no approved portrait'
                : 'no approved establishing frame'
              : on
                ? 'used'
                : `not used, max ${MAX_REFS}`
            return (
              <li key={r.key} className={cn('flex w-[72px] flex-col gap-1', !on && 'opacity-70')}>
                <div className={cn('darkroom aspect-square overflow-hidden rounded-[4px]', !r.image && 'border-dashed')}>
                  {r.image?.media_url ? (
                    <img src={r.image.media_url} alt="" className="size-full object-cover" loading="lazy" />
                  ) : (
                    <span className="flex size-full items-center justify-center text-studio-on-dark-muted">
                      <Icon aria-hidden className="size-4" />
                    </span>
                  )}
                </div>
                <span className="truncate text-[12px] font-medium" title={r.name}>
                  {r.name}
                </span>
                <span className={cn('text-[11px] leading-tight', on ? 'text-studio-success' : 'text-studio-muted')}>{why}</span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
