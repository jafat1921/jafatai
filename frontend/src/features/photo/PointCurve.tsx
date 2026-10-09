import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { monotone } from '@/lib/photo/maths'

export type Pt = [number, number]

const W = 240
const H = 200
const PAD = 8
const STRAIGHT: Pt[] = [[0, 0], [255, 255]]

const COLOURS: Record<string, string> = { rgb: 'var(--accent-gold)', red: '#d0503c', green: '#4aa564', blue: '#4a78c8' }

/**
 * Lightroom's point curve for one channel. Click to add a point, drag to move it (it can't pass its
 * neighbours), double-click or Delete to remove it; arrows nudge the focused point (Shift ×10).
 */
export function PointCurve({ channel, points, onChange }: { channel: string; points: Pt[] | undefined; onChange: (pts: Pt[], group: string) => void }) {
  const svg = useRef<SVGSVGElement>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const pts = points?.length ? points : STRAIGHT
  const sx = (v: number) => PAD + (v / 255) * (W - PAD * 2)
  const sy = (v: number) => H - PAD - (v / 255) * (H - PAD * 2)
  const group = `points:${channel}`

  const toData = (e: { clientX: number; clientY: number }): Pt => {
    const b = svg.current!.getBoundingClientRect()
    const x = (((e.clientX - b.left) / b.width) * W - PAD) / (W - PAD * 2)
    const y = (H - PAD - ((e.clientY - b.top) / b.height) * H) / (H - PAD * 2)
    return [Math.round(Math.max(0, Math.min(1, x)) * 255), Math.round(Math.max(0, Math.min(1, y)) * 255)]
  }

  const move = (i: number, x: number, y: number, g = group) => {
    const next = pts.map((p) => [...p] as Pt)
    // the ends stay at the ends; the rest can't cross a neighbour
    const lo = i === 0 ? 0 : next[i - 1][0] + 1
    const hi = i === next.length - 1 ? 255 : next[i + 1][0] - 1
    next[i] = [i === 0 ? 0 : i === next.length - 1 ? 255 : Math.max(lo, Math.min(hi, x)), Math.max(0, Math.min(255, y))]
    onChange(next, g)
  }
  const remove = (i: number) => {
    if (i === 0 || i === pts.length - 1) return
    onChange(pts.filter((_, j) => j !== i), `${group}:remove`)
  }

  const onDown = (e: PointerEvent<SVGSVGElement>) => {
    if ((e.target as Element).tagName === 'circle') return
    const [x] = toData(e)
    if (pts.some(([px]) => Math.abs(px - x) < 4)) return
    // a new point lands on the curve, so adding one changes nothing until it's moved
    const y = Math.round(monotone(pts, x / 255) * 255)
    const next = [...pts, [x, y] as Pt].sort((a, b) => a[0] - b[0])
    onChange(next, `${group}:add`)
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setDrag(next.findIndex((p) => p[0] === x))
  }

  const onKey = (i: number) => (e: KeyboardEvent<SVGCircleElement>) => {
    const k = e.shiftKey ? 10 : 1
    const [x, y] = pts[i]
    if (e.key === 'ArrowUp') move(i, x, y + k)
    else if (e.key === 'ArrowDown') move(i, x, y - k)
    else if (e.key === 'ArrowLeft') move(i, x - k, y)
    else if (e.key === 'ArrowRight') move(i, x + k, y)
    else if (e.key === 'Delete' || e.key === 'Backspace') remove(i)
    else return
    e.preventDefault()
  }

  const line = `M${Array.from({ length: 65 }, (_, i) => `${sx((i / 64) * 255).toFixed(1)},${sy(monotone(pts, i / 64) * 255).toFixed(1)}`).join('L')}`

  return (
    <svg
      ref={svg}
      viewBox={`0 0 ${W} ${H}`}
      className="darkroom w-full cursor-crosshair touch-none select-none rounded-[6px]"
      role="group"
      aria-label={`${channel === 'rgb' ? 'RGB' : channel} point curve`}
      onPointerDown={onDown}
      onPointerMove={(e) => {
        if (drag == null) return
        const [x, y] = toData(e)
        move(drag, x, y)
      }}
      onPointerUp={() => setDrag(null)}
      onPointerCancel={() => setDrag(null)}
    >
      {[64, 128, 192].map((g) => (
        <g key={g} stroke="rgb(244 234 213 / 0.1)">
          <line x1={sx(g)} x2={sx(g)} y1={PAD} y2={H - PAD} />
          <line y1={sy(g)} y2={sy(g)} x1={PAD} x2={W - PAD} />
        </g>
      ))}
      <line x1={sx(0)} y1={sy(0)} x2={sx(255)} y2={sy(255)} stroke="rgb(244 234 213 / 0.25)" strokeDasharray="3 3" />
      <path d={line} fill="none" stroke={COLOURS[channel]} strokeWidth={1.8} />
      {pts.map(([x, y], i) => (
        <circle
          key={i}
          cx={sx(x)}
          cy={sy(y)}
          r={drag === i ? 6.5 : 5}
          tabIndex={0}
          role="slider"
          aria-label={`Point ${i + 1} at input ${x}`}
          aria-valuemin={0}
          aria-valuemax={255}
          aria-valuenow={y}
          fill={COLOURS[channel]}
          stroke="var(--darkroom)"
          strokeWidth={1.5}
          className="cursor-move outline-none focus-visible:[stroke-width:4]"
          onPointerDown={(e) => {
            e.stopPropagation()
            svg.current?.setPointerCapture?.(e.pointerId)
            setDrag(i)
          }}
          onDoubleClick={() => remove(i)}
          onKeyDown={onKey(i)}
        >
          <title>{`${x} → ${y}`}</title>
        </circle>
      ))}
    </svg>
  )
}
