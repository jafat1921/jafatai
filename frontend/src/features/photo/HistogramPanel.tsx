import { useRef, useState, type PointerEvent } from 'react'
import { Triangle } from 'lucide-react'
import { getValue } from '@/lib/photo/params'
import type { DevelopParams, Histogram } from '@/lib/photo/types'
import { cn } from '@/lib/utils'

const W = 256
const H = 72

// Lightroom's histogram regions: drag one sideways to move its slider
const REGIONS = [
  { key: 'blacks', label: 'Blacks', from: 0, to: 0.1 },
  { key: 'shadows', label: 'Shadows', from: 0.1, to: 0.35 },
  { key: 'exposure', label: 'Exposure', from: 0.35, to: 0.65 },
  { key: 'highlights', label: 'Highlights', from: 0.65, to: 0.9 },
  { key: 'whites', label: 'Whites', from: 0.9, to: 1 },
] as const

const area = (bins: number[]) => {
  const pts: string[] = [`M0,${H}`]
  for (let i = 0; i < bins.length; i += 2) pts.push(`L${i},${(H - Math.min(1, bins[i]) * (H - 2)).toFixed(1)}`)
  pts.push(`L${W},${H}Z`)
  return pts.join('')
}
const pct = (v: number) => (v >= 0.001 ? `${(v * 100).toFixed(v < 0.01 ? 1 : 0)}%` : '0%')
const fmt = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v)}`

interface Props {
  data: Histogram | null
  params: DevelopParams
  onSet: (key: string, value: number, group: string | null) => void
  clip: boolean
  onClip: () => void
  // pixel under the pointer on the canvas, 0..255
  readout: [number, number, number] | null
  exif: string | null
}

/**
 * Lightroom's histogram: drag a tonal region to move its slider, the corner triangles (J) show clipping
 * on the photo, and the line under it reads R/G/B under the pointer or the camera settings.
 */
export function HistogramPanel({ data, params, onSet, clip, onClip, readout, exif }: Props) {
  const [hover, setHover] = useState<(typeof REGIONS)[number] | null>(null)
  const drag = useRef<{ key: string; x: number; start: number; width: number } | null>(null)

  const regionAt = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const f = (e.clientX - r.left) / r.width
    return REGIONS.find((g) => f >= g.from && f <= g.to) ?? REGIONS[2]
  }
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const g = regionAt(e)
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = { key: g.key, x: e.clientX, start: getValue(params, g.key), width: e.currentTarget.getBoundingClientRect().width }
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) {
      setHover(regionAt(e))
      return
    }
    // the full width of the histogram is the slider's whole range
    const v = Math.max(-100, Math.min(100, d.start + ((e.clientX - d.x) / d.width) * 200))
    onSet(d.key, Math.round(v), `hist:${d.key}`)
  }
  const shadowsClipped = !!data && data.clipped.shadows > 0.001
  const highsClipped = !!data && data.clipped.highlights > 0.001

  return (
    <figure className="flex flex-col gap-1" aria-label="Histogram">
      <div
        className="darkroom relative h-[72px] cursor-ew-resize touch-none overflow-hidden rounded-[6px]"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onPointerLeave={() => !drag.current && setHover(null)}
        title="Drag left or right to adjust that part of the tones"
      >
        {data ? (
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="size-full" aria-hidden>
            {hover && <rect x={hover.from * W} width={(hover.to - hover.from) * W} y={0} height={H} fill="rgb(244 234 213 / 0.12)" />}
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
        {(['shadows', 'highlights'] as const).map((side) => {
          const on = side === 'shadows' ? shadowsClipped : highsClipped
          return (
            <button
              key={side}
              type="button"
              aria-pressed={clip}
              aria-label={`Show clipping on the photo (J). ${side === 'shadows' ? 'Shadows' : 'Highlights'} ${on ? 'are clipped' : 'are not clipped'}`}
              title="Show clipping (J)"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onClip}
              className={cn('absolute top-1 rounded-[3px] p-0.5', side === 'shadows' ? 'left-1' : 'right-1', clip ? 'bg-white/25' : 'hover:bg-white/15')}
            >
              <Triangle aria-hidden className={cn('size-3', side === 'shadows' ? '-rotate-90' : 'rotate-90', on ? (side === 'shadows' ? 'fill-sky-400 text-sky-400' : 'fill-red-400 text-red-400') : 'text-white/50')} />
            </button>
          )
        })}
      </div>
      <figcaption className="flex min-h-4 justify-between gap-2 text-[12px] text-studio-muted" aria-live="off">
        {hover ? (
          <span>
            <span className="font-medium text-studio-text">{hover.label}</span> {fmt(getValue(params, hover.key))}
          </span>
        ) : readout ? (
          <span className="font-mono">R {Math.round((readout[0] / 255) * 100)} G {Math.round((readout[1] / 255) * 100)} B {Math.round((readout[2] / 255) * 100)} %</span>
        ) : (
          <span className="truncate">{exif ?? (data ? `Shadows clipped ${pct(data.clipped.shadows)}` : 'Reading tones…')}</span>
        )}
        <span className={cn('shrink-0', highsClipped && 'font-medium text-studio-warning')}>{data ? `Highlights ${pct(data.clipped.highlights)}` : ''}</span>
      </figcaption>
    </figure>
  )
}
