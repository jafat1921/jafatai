import { useId } from 'react'
import { detailLabel } from '@/lib/imageUpscale'

const STOPS = ['Subtle', 'Balanced', 'Strong'] as const

/** Denoise for the Redraw engine, in words. Native range input: arrow keys, Home/End and touch for free. */
export function DetailSlider({
  value,
  min,
  max,
  onChange,
}: {
  value: number
  min: number
  max: number
  onChange: (v: number) => void
}) {
  const id = useId()
  const label = detailLabel(value)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="section-label">
          Detail strength
        </label>
        <span className="text-small text-studio-text" aria-hidden>
          {label} <span className="font-mono text-studio-muted">{value.toFixed(2)}</span>
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={0.01}
        value={value}
        aria-valuetext={`${label}, ${value.toFixed(2)}`}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-6 w-full cursor-pointer accent-[var(--accent)]"
      />
      <div className="flex justify-between text-small text-studio-muted" aria-hidden>
        {STOPS.map((s) => (
          <span key={s} className={s === label ? 'font-medium text-studio-text' : undefined}>
            {s}
          </span>
        ))}
      </div>
      <p className="text-small text-studio-muted">
        Subtle keeps the picture as it is. Strong invents more texture and can change small details like eyes or lettering.
      </p>
    </div>
  )
}
