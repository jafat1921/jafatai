import type { Histogram } from '@/lib/photo/types'

const W = 256
const H = 64

const area = (bins: number[]) => {
  // every other bin keeps the path short; the eye can't tell at this size
  const pts: string[] = [`M0,${H}`]
  for (let i = 0; i < bins.length; i += 2) pts.push(`L${i},${(H - Math.min(1, bins[i]) * (H - 2)).toFixed(1)}`)
  pts.push(`L${W},${H}Z`)
  return pts.join('')
}

const pct = (v: number) => (v >= 0.001 ? `${(v * 100).toFixed(v < 0.01 ? 1 : 0)}%` : '0%')

/** RGB + luma histogram of what's on the canvas, with clipping warnings in words, not colour alone. */
export function HistogramView({ data, live }: { data: Histogram | null; live: boolean }) {
  const warn = data && (data.clipped.shadows > 0.01 || data.clipped.highlights > 0.01)
  return (
    <figure className="flex flex-col gap-1" aria-label="Histogram">
      <div className="darkroom relative h-16 overflow-hidden rounded-[6px]">
        {data ? (
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="size-full" aria-hidden>
            <g style={{ mixBlendMode: 'screen' }}>
              <path d={area(data.r)} fill="rgb(225 80 80 / 0.6)" />
              <path d={area(data.g)} fill="rgb(80 200 110 / 0.6)" />
              <path d={area(data.b)} fill="rgb(80 130 235 / 0.6)" />
            </g>
            <path d={area(data.luma)} fill="none" stroke="rgb(244 234 213 / 0.7)" strokeWidth={1} />
          </svg>
        ) : (
          <div className="shimmer-dark size-full" />
        )}
      </div>
      <figcaption className="flex justify-between gap-2 text-[12px] text-studio-muted">
        <span>{data ? `Shadows clipped ${pct(data.clipped.shadows)}` : 'Reading tones…'}</span>
        <span className={warn ? 'font-medium text-studio-warning' : undefined}>
          {data ? `Highlights clipped ${pct(data.clipped.highlights)}` : live ? 'Live' : 'Server'}
        </span>
      </figcaption>
    </figure>
  )
}
