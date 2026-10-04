import { useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { fieldClass } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Chip } from '@/components/studio/chip'
import { TRANSITION_MAX_S, TRANSITION_MIN_S, TRANSITIONS, transitionLabel } from '@/lib/reel'
import type { ReelClip, ReelClipPatch } from '@/lib/types'
import { cn } from '@/lib/utils'

interface FieldsProps {
  clip: Pick<ReelClip, 'id' | 'transition_in' | 'transition_s'>
  onChange: (patch: ReelClipPatch) => void
}

/** Kind (Cut / Dissolve / Fade) plus its length. Used in the chip popover and the clip inspector. */
export function TransitionFields({ clip, onChange }: FieldsProps) {
  const uid = useId()
  const [seconds, setSeconds] = useState(String(clip.transition_s))
  const [seen, setSeen] = useState(clip.transition_s)
  const [error, setError] = useState<string | null>(null)
  if (clip.transition_s !== seen) {
    setSeen(clip.transition_s)
    setSeconds(String(clip.transition_s))
  }

  const commit = () => {
    const v = Number(seconds)
    if (!Number.isFinite(v) || v < TRANSITION_MIN_S || v > TRANSITION_MAX_S) {
      setError(`Between ${TRANSITION_MIN_S} and ${TRANSITION_MAX_S} seconds.`)
      return
    }
    setError(null)
    if (v !== clip.transition_s) onChange({ transition_s: v })
  }

  return (
    <div className="flex flex-col gap-2">
      <div role="radiogroup" aria-labelledby={`${uid}-kind`} className="flex flex-col gap-1">
        <span id={`${uid}-kind`} className="section-label">
          Transition in
        </span>
        <div className="flex flex-wrap gap-1">
          {TRANSITIONS.map((t) => (
            <Chip
              key={t.value}
              role="radio"
              aria-checked={clip.transition_in === t.value}
              aria-pressed={undefined}
              selected={clip.transition_in === t.value}
              onClick={() => t.value !== clip.transition_in && onChange({ transition_in: t.value })}
            >
              {t.label}
            </Chip>
          ))}
        </div>
      </div>
      {clip.transition_in !== 'cut' && (
        <div className="flex flex-col gap-0.5">
          <label htmlFor={`${uid}-s`} className="text-small text-studio-muted">
            Length (seconds)
          </label>
          <input
            id={`${uid}-s`}
            type="number"
            step={0.1}
            min={TRANSITION_MIN_S}
            max={TRANSITION_MAX_S}
            value={seconds}
            aria-invalid={!!error || undefined}
            onChange={(e) => setSeconds(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
            className={cn(fieldClass, 'h-7 w-24 font-mono text-small')}
          />
          {error && (
            <p role="alert" className="text-small text-studio-danger">
              {error}
            </p>
          )}
          <p className="text-small text-studio-muted">Shortened automatically if a neighbouring clip is very short.</p>
        </div>
      )}
    </div>
  )
}

/** The small chip that sits between two clips on the strip. */
export function TransitionChip({ clip, label, onChange }: FieldsProps & { label: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Transition into ${label}: ${transitionLabel(clip)}. Change`}
          className={cn(
            'inline-flex h-6 shrink-0 items-center gap-0.5 self-center rounded-full border px-2 text-[11px] font-medium transition-colors',
            clip.transition_in === 'cut'
              ? 'border-studio-border-strong bg-studio-raised text-studio-muted hover:text-studio-text'
              : 'border-studio-accent bg-studio-accent-soft text-studio-accent-hover',
          )}
        >
          {transitionLabel(clip)}
          <ChevronDown aria-hidden className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64">
        <TransitionFields clip={clip} onChange={onChange} />
      </PopoverContent>
    </Popover>
  )
}
