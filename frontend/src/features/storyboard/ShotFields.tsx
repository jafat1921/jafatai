import { useState } from 'react'
import { Chip } from '@/components/studio/chip'
import { DurationPicker } from '@/components/studio/duration-picker'
import { fieldClass } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useCharacters } from '@/hooks/useCharacters'
import { useUpdateShot } from '@/hooks/useShots'
import { SHOT_TYPES } from '@/lib/shots'
import type { Shot, ShotPatch, ShotType } from '@/lib/types'
import { cn } from '@/lib/utils'
import { LocationPicker } from '@/features/workspace/LocationPicker'
import { BrandPlacements } from './BrandPlacements'

// Inline shot details on a Storyboard row: type, duration, description, cast and location.
export function ShotFields({ shot, label }: { shot: Shot; label: string }) {
  const update = useUpdateShot(shot.project_id)
  const { data: cast } = useCharacters(shot.project_id)
  const [description, setDescription] = useState(shot.description)
  const [seenDescription, setSeenDescription] = useState(shot.description)
  // AI rewrites land via SSE; adopt them unless the user is mid-edit
  if (shot.description !== seenDescription) {
    setSeenDescription(shot.description)
    setDescription(shot.description)
  }
  const save = (patch: ShotPatch) => update.mutate({ id: shot.id, patch })
  const id = (f: string) => `shot-${shot.id}-${f}`

  const toggleCharacter = (cid: string) => {
    const has = shot.character_ids.includes(cid)
    save({ character_ids: has ? shot.character_ids.filter((x) => x !== cid) : [...shot.character_ids, cid] })
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-0.5">
          <label htmlFor={id('type')} className="section-label">
            Shot type
          </label>
          <select
            id={id('type')}
            className={cn(fieldClass, 'h-7 w-40 text-small')}
            value={shot.shot_type}
            onChange={(e) => save({ shot_type: e.target.value as ShotType })}
          >
            {SHOT_TYPES.map((t) => (
              <option key={t.value} value={t.value} disabled={t.disabled}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-0.5">
          <label htmlFor={id('dur')} className="section-label">
            Length
          </label>
          <DurationPicker
            id={id('dur')}
            value={shot.duration_s}
            shotId={shot.id}
            label={`Length of shot ${label}`}
            onChange={(v) => save({ duration_s: v })}
          />
        </div>
        <div className="min-w-40 flex-1">
          <LocationPicker
            id={id('loc')}
            compact
            value={shot.location_id ?? null}
            onChange={(v) => save({ location_id: v })}
          />
        </div>
      </div>
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id('desc')} className="section-label">
          Description
        </label>
        <Textarea
          id={id('desc')}
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => description !== shot.description && save({ description })}
          placeholder={`What happens in shot ${label}?`}
          className="min-h-14 text-small"
        />
      </div>
      {cast && cast.length > 0 && (
        <div role="group" aria-label={`Characters in shot ${label}`} className="flex flex-wrap gap-1">
          {cast.map((c) => (
            <Chip
              key={c.id}
              selected={shot.character_ids.includes(c.id)}
              onClick={() => toggleCharacter(c.id)}
              className="h-6"
            >
              {c.name}
            </Chip>
          ))}
        </div>
      )}
      <BrandPlacements shot={shot} label={label} />
      {update.isError && (
        <p role="alert" className="text-small text-studio-danger">
          Couldn&apos;t save: {update.error.message}
        </p>
      )}
    </div>
  )
}
