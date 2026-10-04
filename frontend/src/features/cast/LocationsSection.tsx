import { useState } from 'react'
import { MapPin, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/studio/states'
import { StatusPill } from '@/components/studio/status-pill'
import { useSelectedLocation } from '@/features/workspace/selection'
import type { Location } from '@/lib/types'
import { cn, plural } from '@/lib/utils'
import { announce, useUi } from '@/stores/ui'
import { ExtractLocationsButton } from './ExtractCharactersButton'
import { LocationDialog } from './LocationDialog'

function LocationCard({ l, selected, onSelect }: { l: Location; selected: boolean; onSelect: () => void }) {
  const frame = l.approved_establishing?.media_url
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'flex w-full flex-col overflow-hidden rounded-[6px] border bg-studio-panel text-left shadow-card transition-colors duration-150',
        selected ? 'border-studio-accent ring-1 ring-studio-accent' : 'border-studio-border-strong hover:bg-studio-panel-hover',
      )}
    >
      <div className="darkroom aspect-video border-x-0 border-t-0">
        {frame ? (
          <img src={frame} alt={`Establishing frame of ${l.name}`} className="size-full object-cover" loading="lazy" />
        ) : (
          <div className="flex size-full items-center justify-center text-studio-on-dark-muted">
            <MapPin aria-hidden className="size-7" />
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1.5 p-2.5">
        <span className="truncate font-display text-panel font-semibold">{l.name}</span>
        {l.description && <span className="line-clamp-2 text-small text-studio-muted">{l.description}</span>}
        <StatusPill
          className="self-start"
          status={
            l.approved_establishing
              ? { label: 'Frame approved', tone: 'success', icon: 'check' }
              : { label: 'No establishing frame', tone: 'neutral', icon: 'clock' }
          }
        />
      </div>
    </button>
  )
}

export function LocationsSection({ projectId }: { projectId: string }) {
  const { locations, location, select } = useSelectedLocation()
  const [adding, setAdding] = useState(false)
  const [aiError, setAiError] = useState<unknown>(null)
  const list = locations.data ?? []

  return (
    <section aria-labelledby="locations-heading" className="mt-8">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="locations-heading" className="font-display text-panel font-semibold">
            Locations
          </h2>
          <p className="text-small text-studio-muted">
            {locations.data ? plural(list.length, 'location') : 'Places'} · an approved establishing frame keeps each place
            consistent across shots
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ExtractLocationsButton projectId={projectId} onError={setAiError} />
          <Button variant="secondary" onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            Add location
          </Button>
        </div>
      </div>
      {aiError ? <ErrorState compact className="mb-3" title="Couldn't extract locations" error={aiError} /> : null}

      {locations.isPending && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3" role="status" aria-label="Loading locations">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="aspect-[4/3]" />
          ))}
        </div>
      )}
      {locations.isError && <ErrorState error={locations.error} onRetry={() => locations.refetch()} />}
      {locations.isSuccess && list.length === 0 && (
        <p className="rounded-[6px] border border-dashed border-studio-border-strong p-4 text-body text-studio-muted">
          No locations yet. Extract them from the script, or add one by hand.
        </p>
      )}
      {list.length > 0 && (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {list.map((l) => (
            <li key={l.id} className="flex">
              <LocationCard
                l={l}
                selected={location?.id === l.id}
                onSelect={() => {
                  select(l.id)
                  useUi.getState().setInspectorOpen(true)
                }}
              />
            </li>
          ))}
        </ul>
      )}

      <LocationDialog
        projectId={projectId}
        open={adding}
        onOpenChange={setAdding}
        onSaved={(l) => {
          setAdding(false)
          select(l.id)
          announce(`${l.name} added. Generate an establishing frame in the Inspector.`)
        }}
      />
    </section>
  )
}
