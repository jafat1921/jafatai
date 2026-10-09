import { useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import type { LightPoint } from '@/lib/photo/types'
import { cn } from '@/lib/utils'

export const MAX_POINTS = 16
const DEFAULT_EXPOSURE = 30

interface Props {
  points: LightPoint[]
  frame: { width: number; height: number }
  box: { width: number; height: number }
  placing: boolean
  selected: number | null
  onSelect: (i: number | null) => void
  onChange: (points: LightPoint[], group: string) => void
}

const ev = (e: number) => `${e >= 0 ? '+' : ''}${((1.5 * e) / 100).toFixed(2)} EV`

/**
 * Local light pins on the developed frame. Click to place (while placing), drag to move. A focused
 * pin: arrows move it, + / − brighten or darken, Delete removes it.
 */
export function LightPointsOverlay({ points, frame, box, placing, selected, onSelect, onChange }: Props) {
  const [drag, setDrag] = useState<{ i: number; x: number; y: number; start: LightPoint } | null>(null)
  const k = box.width / frame.width
  // points carry their own reference size; show them on the current frame
  const at = (p: LightPoint) => ({ x: (p.x / (p.refW || frame.width)) * box.width, y: (p.y / (p.refH || frame.height)) * box.height })
  const radius = (p: LightPoint) => ((p.falloff ?? 0.25 * Math.max(p.refW || frame.width, p.refH || frame.height)) / (p.refW || frame.width)) * box.width

  const update = (i: number, patch: Partial<LightPoint>, group: string) => onChange(points.map((p, j) => (j === i ? { ...p, ...patch } : p)), group)

  const onPlace = (e: MouseEvent<HTMLDivElement>) => {
    if (!placing || e.target !== e.currentTarget || points.length >= MAX_POINTS) return
    const r = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - r.left) / k
    const y = (e.clientY - r.top) / k
    const next = [...points, { x: Math.round(x), y: Math.round(y), exposure: DEFAULT_EXPOSURE, falloff: Math.round(0.25 * Math.max(frame.width, frame.height)), refW: Math.round(frame.width), refH: Math.round(frame.height) }]
    onChange(next, `point-add:${next.length}`)
    onSelect(next.length - 1)
  }

  const onKey = (i: number) => (e: KeyboardEvent<HTMLButtonElement>) => {
    const p = points[i]
    const s = (e.shiftKey ? 0.05 : 0.01) * Math.max(p.refW || frame.width, p.refH || frame.height)
    const moves: Record<string, [number, number]> = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] }
    if (moves[e.key]) update(i, { x: Math.round(p.x + moves[e.key][0]), y: Math.round(p.y + moves[e.key][1]) }, `point-move:${i}`)
    else if (e.key === '+' || e.key === '=') update(i, { exposure: Math.min(100, p.exposure + (e.shiftKey ? 10 : 5)) }, `point-ev:${i}`)
    else if (e.key === '-' || e.key === '_') update(i, { exposure: Math.max(-100, p.exposure - (e.shiftKey ? 10 : 5)) }, `point-ev:${i}`)
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      onChange(points.filter((_, j) => j !== i), `point-del:${i}`)
      onSelect(null)
    } else return
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div
      className={cn('absolute inset-0', placing && 'cursor-crosshair')}
      onClick={onPlace}
      onPointerMove={(e: PointerEvent<HTMLDivElement>) => {
        if (!drag) return
        const p = drag.start
        const sx = (p.refW || frame.width) / box.width
        const sy = (p.refH || frame.height) / box.height
        update(drag.i, { x: Math.round(p.x + (e.clientX - drag.x) * sx), y: Math.round(p.y + (e.clientY - drag.y) * sy) }, `point-move:${drag.i}`)
      }}
      onPointerUp={() => setDrag(null)}
      onPointerCancel={() => setDrag(null)}
      aria-label={placing ? 'Click the picture to place a light point' : undefined}
    >
      {points.map((p, i) => {
        const pos = at(p)
        const r = radius(p)
        const on = selected === i
        return (
          <div key={i} className="pointer-events-none absolute" style={{ left: pos.x, top: pos.y }}>
            <span
              aria-hidden
              className={cn('absolute rounded-full border border-dashed', p.exposure >= 0 ? 'border-studio-gold/70' : 'border-sky-300/70', !on && 'opacity-50')}
              style={{ width: r * 2, height: r * 2, left: -r, top: -r }}
            />
            <button
              type="button"
              aria-label={`Light point ${i + 1}, ${ev(p.exposure)}`}
              aria-pressed={on}
              className={cn(
                'pointer-events-auto absolute -left-2.5 -top-2.5 size-5 touch-none rounded-full border-2 border-studio-darkroom',
                p.exposure >= 0 ? 'bg-studio-gold' : 'bg-sky-300',
                on && 'ring-2 ring-studio-on-dark',
              )}
              onPointerDown={(e) => {
                e.stopPropagation()
                e.currentTarget.setPointerCapture?.(e.pointerId)
                onSelect(i)
                setDrag({ i, x: e.clientX, y: e.clientY, start: p })
              }}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={onKey(i)}
              onFocus={() => onSelect(i)}
            />
          </div>
        )
      })}
    </div>
  )
}
