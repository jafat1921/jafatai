import { useId, useState, type ReactNode } from 'react'
import { ChevronDown, Timer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { fieldClass } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Chip } from '@/components/studio/chip'
import { useShotEstimate } from '@/hooks/useEstimate'
import {
  DURATION_PRESETS,
  durationError,
  estimateText,
  formatDuration,
  isLongTakeDuration,
  parseDuration,
} from '@/lib/duration'
import { cn } from '@/lib/utils'

interface Props {
  value: number
  onChange: (seconds: number) => void
  // with a shot id the picker asks the server for chunks and GPU time
  shotId?: string
  count?: number
  max?: number
  label?: string
  className?: string
  // Quick Create brings its own lengths, limits and estimate line
  presets?: { value: number; label: string }[]
  min?: number
  limitNoun?: string
  estimateLine?: ReactNode
}

/** Presets plus a free-text box; the estimate line updates with whatever is picked. */
export function DurationFields({
  value,
  onChange,
  shotId,
  count = 1,
  max: maxProp,
  label = 'Duration',
  className,
  presets = DURATION_PRESETS,
  min = 1,
  limitNoun = ' per take',
  estimateLine,
}: Props) {
  const uid = useId()
  const { estimate, exact, max: serverMax } = useShotEstimate(estimateLine === undefined ? shotId : undefined, value)
  const isPreset = (v: number) => presets.some((p) => p.value === v)
  const max = maxProp ?? serverMax
  const [text, setText] = useState(isPreset(value) ? '' : String(value))
  const [seen, setSeen] = useState(value)
  const [error, setError] = useState<string | null>(null)
  if (value !== seen) {
    setSeen(value)
    setText(isPreset(value) ? '' : String(value))
    setError(null)
  }

  const commit = () => {
    if (!text.trim()) {
      setError(null)
      return
    }
    const secs = parseDuration(text)
    const err = durationError(secs, max, min, limitNoun)
    setError(err)
    if (!err && secs !== value) onChange(secs!)
  }

  return (
    <div role="group" aria-labelledby={`${uid}-label`} className={cn('flex flex-col gap-2', className)}>
      <span id={`${uid}-label`} className="section-label">
        {label}
      </span>
      <div className="flex flex-wrap gap-1">
        {presets.map((p) => (
          <Chip
            key={p.value}
            selected={value === p.value}
            disabled={p.value > max}
            onClick={() => p.value !== value && onChange(p.value)}
            className="disabled:opacity-50"
          >
            {p.label}
          </Chip>
        ))}
      </div>
      <div className="flex flex-col gap-0.5">
        <label htmlFor={`${uid}-custom`} className="text-small text-studio-muted">
          Custom (up to {formatDuration(max)})
        </label>
        <input
          id={`${uid}-custom`}
          inputMode="text"
          autoComplete="off"
          value={text}
          placeholder="75, 1:15 or 2m"
          aria-invalid={!!error || undefined}
          aria-describedby={error ? `${uid}-err` : undefined}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            }
          }}
          className={cn(fieldClass, 'h-7 w-36 font-mono text-small')}
        />
        {error && (
          <p id={`${uid}-err`} role="alert" className="text-small text-studio-danger">
            {error}
          </p>
        )}
      </div>
      {estimateLine !== undefined ? (
        estimateLine
      ) : estimate ? (
        <p aria-live="polite" className="text-small text-studio-muted">
          <span className="font-mono text-studio-text">{formatDuration(value)}</span> · {estimateText(estimate, count)}
          {!exact && ' (rough)'}
        </p>
      ) : null}
      {estimateLine === undefined && isLongTakeDuration(value) && (
        <p className="text-small text-studio-muted">
          Long take: made in chunks and joined into one continuous shot. Needs an approved START frame.
        </p>
      )}
    </div>
  )
}

/** A small button showing the duration; the picker opens in a popover. Used inside dense rows. */
export function DurationPicker(props: Props & { id?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={props.id}
          size="sm"
          variant="secondary"
          aria-label={`${props.label ?? 'Duration'}: ${formatDuration(props.value)}. Change`}
          className="h-7 font-mono"
        >
          <Timer aria-hidden />
          {formatDuration(props.value)}
          <ChevronDown aria-hidden className="text-studio-muted" />
        </Button>
      </PopoverTrigger>
      <PopoverContent>
        <DurationFields
          {...props}
          onChange={(v) => {
            props.onChange(v)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
