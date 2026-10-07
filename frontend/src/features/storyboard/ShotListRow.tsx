import { useState } from 'react'
import { GripVertical, Link2, Scissors, Stamp, Trash2, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { fieldClass } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { LONGTAKE_MAX_S } from '@/lib/duration'
import { SHOT_TYPES } from '@/lib/shots'
import type { Character, Shot, ShotPatch, ShotType } from '@/lib/types'
import { cn, plural } from '@/lib/utils'
import { ShotCameraChip } from './ShotCamera'
import { canSplit } from './shotList'

interface Props {
  shot: Shot
  label: string
  index: number
  count: number
  firstOfFilm: boolean
  cast: Character[]
  selected: boolean
  dragging: boolean
  onSelect: (on: boolean) => void
  onPatch: (patch: ShotPatch) => void
  onMove: (to: number) => void
  onSplit: () => void
  onDelete: () => void
  onDragStart: () => void
  onDragEnd: () => void
  onDropOn: () => void
}

const cell = 'border-b border-studio-border px-2 py-1.5 align-top'

/** Text that saves on blur or Enter (Shift+Enter for a new line in the description). */
function EditText({
  value,
  label,
  multiline,
  onSave,
  className,
}: {
  value: string
  label: string
  multiline?: boolean
  onSave: (v: string) => void
  className?: string
}) {
  const [draft, setDraft] = useState(value)
  const [seen, setSeen] = useState(value)
  // server-side changes (merge, AI rewrites over SSE) win unless the user is typing
  if (value !== seen) {
    setSeen(value)
    setDraft(value)
  }
  const commit = () => draft.trim() !== value.trim() && onSave(draft.trim())
  const props = {
    'aria-label': label,
    value: draft,
    onBlur: commit,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        commit()
      } else if (e.key === 'Escape') {
        setDraft(value)
      }
    },
  }
  return multiline ? (
    <textarea {...props} rows={2} className={cn(fieldClass, 'min-h-14 resize-y py-1 text-small', className)} />
  ) : (
    <input {...props} className={cn(fieldClass, 'h-7 text-small', className)} />
  )
}

export function ShotListRow(p: Props) {
  const { shot, label } = p
  const [duration, setDuration] = useState(String(shot.duration_s))
  const [seenDuration, setSeenDuration] = useState(shot.duration_s)
  if (shot.duration_s !== seenDuration) {
    setSeenDuration(shot.duration_s)
    setDuration(String(shot.duration_s))
  }
  const saveDuration = () => {
    const v = Math.round(Number(duration) * 2) / 2
    if (!Number.isFinite(v) || v < 1 || v > LONGTAKE_MAX_S) return setDuration(String(shot.duration_s))
    if (v !== shot.duration_s) p.onPatch({ duration_s: v })
  }
  const names = p.cast.filter((c) => shot.character_ids.includes(c.id)).map((c) => c.name)
  const placements = shot.brand_placements ?? []

  return (
    <tr
      data-shot-id={shot.id}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        p.onDropOn()
      }}
      className={cn('bg-studio-raised', p.selected && 'bg-studio-accent-soft', p.dragging && 'opacity-50')}
    >
      <td className={cn(cell, 'w-8')}>
        <input
          type="checkbox"
          checked={p.selected}
          onChange={(e) => p.onSelect(e.target.checked)}
          aria-label={`Select shot ${label}`}
          className="mt-1.5 accent-[var(--accent)]"
        />
      </td>
      <td className={cn(cell, 'w-16 whitespace-nowrap')}>
        <span className="flex items-center gap-0.5">
          <button
            type="button"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', shot.id)
              p.onDragStart()
            }}
            onDragEnd={p.onDragEnd}
            onKeyDown={(e) => {
              if (e.key === 'ArrowUp' && p.index > 0) {
                e.preventDefault()
                p.onMove(p.index - 1)
              } else if (e.key === 'ArrowDown' && p.index < p.count - 1) {
                e.preventDefault()
                p.onMove(p.index + 1)
              }
            }}
            aria-label={`Move shot ${label}`}
            aria-describedby="shotlist-move-help"
            data-move-handle={shot.id}
            className="cursor-grab rounded-[4px] p-0.5 text-studio-muted hover:text-studio-text active:cursor-grabbing"
          >
            <GripVertical aria-hidden className="size-4" />
          </button>
          <span className="font-mono text-small font-medium text-studio-accent-hover">{label}</span>
        </span>
      </td>
      <td className={cn(cell, 'w-36')}>
        <select
          aria-label={`Shot type of ${label}`}
          className={cn(fieldClass, 'h-7 text-small')}
          value={shot.shot_type}
          onChange={(e) => p.onPatch({ shot_type: e.target.value as ShotType })}
        >
          {SHOT_TYPES.map((t) => (
            <option key={t.value} value={t.value} disabled={t.disabled}>
              {t.label}
            </option>
          ))}
        </select>
      </td>
      <td className={cn(cell, 'w-20')}>
        <span className="flex items-center gap-1">
          <input
            type="number"
            min={1}
            max={LONGTAKE_MAX_S}
            step={0.5}
            aria-label={`Length of ${label} in seconds`}
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            onBlur={saveDuration}
            onKeyDown={(e) => e.key === 'Enter' && saveDuration()}
            className={cn(fieldClass, 'h-7 w-14 px-1.5 font-mono text-small')}
          />
          <span className="text-small text-studio-muted">s</span>
        </span>
      </td>
      <td className={cn(cell, 'min-w-56')}>
        <EditText value={shot.description} label={`Description of ${label}`} multiline onSave={(v) => p.onPatch({ description: v })} />
      </td>
      <td className={cn(cell, 'min-w-44')}>
        <div className="flex flex-col gap-1">
          <ShotCameraChip shot={shot} />
          {/* the planner's own words stay editable; picking in the rack rewrites them */}
          <EditText value={shot.camera} label={`Camera notes for ${label}`} onSave={(v) => p.onPatch({ camera: v.slice(0, 300) })} />
        </div>
      </td>
      <td className={cn(cell, 'w-32')}>
        <Popover>
          <PopoverTrigger asChild>
            <Button size="sm" variant="ghost" className="h-7 max-w-32 justify-start px-1.5" aria-label={`Characters in ${label}: ${names.join(', ') || 'none'}. Change`}>
              <Users aria-hidden />
              <span className="truncate">{names.length ? names.join(', ') : 'Nobody'}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent aria-label={`Characters in ${label}`} className="flex w-56 flex-col gap-1">
            {p.cast.length === 0 && <p className="text-small text-studio-muted">No cast yet. Add characters in Cast &amp; World.</p>}
            {p.cast.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-body">
                <input
                  type="checkbox"
                  checked={shot.character_ids.includes(c.id)}
                  onChange={(e) =>
                    p.onPatch({
                      character_ids: e.target.checked ? [...shot.character_ids, c.id] : shot.character_ids.filter((x) => x !== c.id),
                    })
                  }
                />
                {c.name}
              </label>
            ))}
          </PopoverContent>
        </Popover>
      </td>
      <td className={cn(cell, 'w-28')}>
        {placements.length ? (
          <span
            className="inline-flex items-center gap-1 text-small"
            title={placements.map((x) => `${x.asset_type} on ${x.surface || 'any surface'} (${x.prominence ?? 'background'})`).join('\n')}
          >
            <Stamp aria-hidden className="size-3 text-studio-gold" />
            {plural(placements.length, 'placement')}
          </span>
        ) : (
          <span className="text-small text-studio-muted">—</span>
        )}
      </td>
      <td className={cn(cell, 'w-28')}>
        <Button
          size="sm"
          variant={shot.seam_in === 'continue' ? 'secondary' : 'ghost'}
          className="h-7 px-1.5"
          disabled={p.firstOfFilm}
          aria-pressed={shot.seam_in === 'continue'}
          aria-label={`Seam into ${label}: ${shot.seam_in === 'continue' ? 'Continue' : 'Cut'}. Toggle`}
          onClick={() => p.onPatch({ seam_in: shot.seam_in === 'continue' ? 'cut' : 'continue' })}
        >
          {shot.seam_in === 'continue' && <Link2 aria-hidden />}
          {shot.seam_in === 'continue' ? 'Continue' : 'Cut'}
        </Button>
      </td>
      <td className={cn(cell, 'w-20 whitespace-nowrap')}>
        <Button size="icon-sm" variant="ghost" aria-label={`Split shot ${label}`} disabled={!canSplit(shot)} onClick={p.onSplit}>
          <Scissors aria-hidden />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label={`Delete shot ${label}`} onClick={p.onDelete}>
          <Trash2 aria-hidden />
        </Button>
      </td>
    </tr>
  )
}
