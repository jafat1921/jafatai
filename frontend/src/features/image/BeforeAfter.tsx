import { useState } from 'react'

/** Source and result stacked; the slider wipes between them. Keyboard: arrow keys on the slider. */
export function BeforeAfter({ before, after, alt }: { before: string; after: string; alt: string }) {
  const [split, setSplit] = useState(50)
  return (
    <figure className="flex flex-col gap-2">
      <div className="darkroom relative aspect-[4/3] w-full overflow-hidden rounded-[6px]">
        <img src={before} alt={`Before: ${alt}`} className="absolute inset-0 size-full object-contain" />
        <img
          src={after}
          alt={`After: ${alt}`}
          className="absolute inset-0 size-full object-contain"
          style={{ clipPath: `inset(0 0 0 ${split}%)` }}
        />
        <span aria-hidden className="absolute inset-y-0 w-px bg-studio-gold" style={{ left: `${split}%` }} />
        <span aria-hidden className="absolute left-2 top-2 rounded bg-studio-darkroom/80 px-1.5 text-small text-studio-on-dark">
          Before
        </span>
        <span aria-hidden className="absolute right-2 top-2 rounded bg-studio-darkroom/80 px-1.5 text-small text-studio-on-dark">
          After
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={split}
        onChange={(e) => setSplit(Number(e.target.value))}
        aria-label="Compare before and after"
        aria-valuetext={`${100 - split}% after`}
        className="w-full accent-[var(--accent)]"
      />
    </figure>
  )
}
