import { useId } from 'react'
import { MapPin, User } from 'lucide-react'
import { ErrorState } from '@/components/studio/states'
import { useShotRefs } from '@/hooks/useCharacterStudio'
import { useUpdateShot } from '@/hooks/useShots'
import type { Shot, ShotRef } from '@/lib/types'
import { cn } from '@/lib/utils'
import { announce } from '@/stores/ui'

// The server attaches up to 3 references: characters first (the sheet panel that fits the framing, contract v25),
// then the location (contract v1, Keyframes).
const MAX_REFS = 3

function why(r: ShotRef, max: number) {
  if (!r.generation) return r.kind === 'character' ? 'no approved portrait' : 'no approved establishing frame'
  return r.used ? 'used' : `not used, max ${max}`
}

function RefTile({ r, shot, max }: { r: ShotRef; shot: Shot; max: number }) {
  const uid = useId()
  const update = useUpdateShot(shot.project_id)
  const Icon = r.kind === 'character' ? User : MapPin
  const img = r.generation?.thumb_url ?? r.generation?.media_url
  const pick = (key: string) =>
    update.mutate(
      { id: shot.id, patch: { ref_panels: { [r.id]: key } } },
      { onSuccess: () => announce(key === 'auto' ? `${r.name}: back to the automatic picture.` : `${r.name}: reference changed.`) },
    )
  return (
    <li className={cn('flex w-[96px] flex-col gap-1', !r.used && 'opacity-70')}>
      <div className={cn('darkroom aspect-square overflow-hidden rounded-[4px]', !img && 'border-dashed')}>
        {img ? (
          <img src={img} alt="" className="size-full object-cover" loading="lazy" />
        ) : (
          <span className="flex size-full items-center justify-center text-studio-on-dark-muted">
            <Icon aria-hidden className="size-4" />
          </span>
        )}
      </div>
      <span dir="auto" className="truncate text-[12px] font-medium" title={r.name}>
        {r.name}
      </span>
      {r.kind === 'character' && r.options.length > 1 ? (
        <>
          <label htmlFor={`${uid}-p`} className="sr-only">
            Reference picture for {r.name}
          </label>
          <select
            id={`${uid}-p`}
            className="h-6 w-full rounded-[4px] border border-studio-border-strong bg-studio-raised px-1 text-[11px]"
            value={r.auto ? 'auto' : (r.panel ?? 'auto')}
            onChange={(e) => pick(e.target.value)}
            disabled={update.isPending}
          >
            <option value="auto">Auto{r.auto && r.panel_label ? `: ${r.panel_label}` : ''}</option>
            {r.options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.key === 'portrait' ? o.label : `${o.section_title}: ${o.label}`}
              </option>
            ))}
          </select>
        </>
      ) : (
        r.panel_label && <span className="truncate text-[11px] text-studio-muted">{r.panel_label}</span>
      )}
      <span className={cn('text-[11px] leading-tight', r.used ? 'text-studio-success' : 'text-studio-muted')}>{why(r, max)}</span>
      {update.isError && <span className="text-[11px] text-studio-danger">Couldn’t change it</span>}
    </li>
  )
}

export function RefsStrip({ shot }: { shot: Shot; sceneLocationId?: string | null }) {
  const refs = useShotRefs(shot.id, shot.updated_at)
  const list = refs.data?.refs ?? []
  const max = refs.data?.max_refs ?? MAX_REFS
  return (
    <section aria-labelledby={`refs-${shot.id}`}>
      <h3 id={`refs-${shot.id}`} className="section-label mb-1.5">
        References used
      </h3>
      {refs.isError ? (
        <ErrorState compact error={refs.error} onRetry={() => refs.refetch()} />
      ) : refs.isSuccess && list.length === 0 ? (
        <p className="text-small text-studio-muted">
          No characters or location on this shot, so the frame is drawn from the prompt alone. Add them on the shot row.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2" aria-busy={refs.isPending}>
          {list.map((r) => (
            <RefTile key={`${r.kind}-${r.id}`} r={r} shot={shot} max={max} />
          ))}
        </ul>
      )}
      {list.some((r) => r.kind === 'character') && (
        <p className="mt-1.5 text-[11px] text-studio-muted">
          With a character sheet, wide shots use the full body, close shots the close-up or the expression the shot names.
        </p>
      )}
    </section>
  )
}
