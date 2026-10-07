import { useId } from 'react'
import { STRENGTH_DEFAULT, STRENGTH_MARKS, STRENGTH_MAX, STRENGTH_MIN, strengthHint, strengthLabel } from '@/lib/img2img'

const pct = (v: number) => ((v - STRENGTH_MIN) / (STRENGTH_MAX - STRENGTH_MIN)) * 100

/** "How much to change": a plain range input, so arrow keys, Home/End and screen readers all just work. */
export function StrengthSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const uid = useId()
  const word = strengthLabel(value)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={`${uid}-s`} className="section-label">
          How much to change
        </label>
        <output htmlFor={`${uid}-s`} className="text-small">
          <span className="font-medium">{word}</span> <span className="font-mono text-studio-muted">{value.toFixed(2)}</span>
        </output>
      </div>
      <input
        id={`${uid}-s`}
        type="range"
        min={STRENGTH_MIN}
        max={STRENGTH_MAX}
        step={0.05}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => onChange(STRENGTH_DEFAULT)}
        aria-valuetext={`${value.toFixed(2)}, ${word}`}
        aria-describedby={`${uid}-h`}
        className="w-full accent-[var(--accent)]"
      />
      <div aria-hidden className="relative h-4 text-small text-studio-muted">
        {STRENGTH_MARKS.map((m, i) => (
          <span
            key={m.label}
            className="absolute -translate-x-1/2 whitespace-nowrap data-[edge=first]:translate-x-0 data-[edge=last]:-translate-x-full"
            data-edge={i === 0 ? 'first' : i === STRENGTH_MARKS.length - 1 ? 'last' : undefined}
            style={{ left: `${i === 0 ? 0 : i === STRENGTH_MARKS.length - 1 ? 100 : pct(m.value)}%` }}
          >
            {m.label}
          </span>
        ))}
      </div>
      <p id={`${uid}-h`} className="text-small text-studio-muted">
        {strengthHint(value)}
      </p>
    </div>
  )
}
