import { useId } from 'react'
import { STRENGTH_DEFAULT, STRENGTH_MARKS, STRENGTH_MAX, STRENGTH_MIN, strengthHint, strengthLabel } from '@/lib/img2img'

const pct = (v: number) => ((v - STRENGTH_MIN) / (STRENGTH_MAX - STRENGTH_MIN)) * 100

/** "Style strength": a plain range input, so arrow keys, Home/End and screen readers all just work. */
export function StrengthSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const uid = useId()
  const word = strengthLabel(value)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={`${uid}-s`} className="section-label">
          Style strength
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
      {/* the marks are presets too: one click sets the slider there */}
      <div role="group" aria-label="Style strength presets" className="relative h-6 text-small">
        {STRENGTH_MARKS.map((m) => (
          <button
            key={m.label}
            type="button"
            onClick={() => onChange(m.value)}
            aria-pressed={Math.abs(value - m.value) < 0.001}
            className="absolute -translate-x-1/2 whitespace-nowrap rounded-[4px] px-1 text-studio-muted hover:text-studio-text aria-pressed:font-medium aria-pressed:text-studio-text"
            style={{ left: `${pct(m.value)}%` }}
          >
            {m.label} {m.value.toFixed(1)}
          </button>
        ))}
      </div>
      <p id={`${uid}-h`} className="text-small text-studio-muted">
        {strengthHint(value)}
      </p>
    </div>
  )
}
