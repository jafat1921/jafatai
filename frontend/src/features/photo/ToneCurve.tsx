import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { toneCurve } from '@/lib/photo/maths'
import type { DevelopParams } from '@/lib/photo/types'

const ANCHORS = [
  { key: 'blacks', t: 0, label: 'Blacks' },
  { key: 'shadows', t: 0.25, label: 'Shadows' },
  { key: 'mids', t: 0.5, label: 'Midtones' },
  { key: 'highlights', t: 0.75, label: 'Highlights' },
  { key: 'whites', t: 1, label: 'Whites' },
] as const

type AnchorKey = (typeof ANCHORS)[number]['key']

const W = 240
const H = 180
const PAD = 8
const clamp = (v: number) => Math.max(-100, Math.min(100, Math.round(v)))

/**
 * The 5-point curve over the whole tone response (contrast and the regional sliders show in the line
 * too). Points move up and down only: drag, or focus one and use ↑/↓ (Shift ×10); double-click resets.
 */
export function ToneCurve({ params, onChange }: { params: DevelopParams; onChange: (key: AnchorKey, value: number, group: string) => void }) {
  const svg = useRef<SVGSVGElement>(null)
  const [drag, setDrag] = useState<{ key: AnchorKey; y0: number; v0: number } | null>(null)
  const curve = params.curve ?? {}
  const value = (k: AnchorKey) => curve[k] ?? 0
  const x = (t: number) => PAD + t * (W - PAD * 2)
  const y = (v: number) => PAD + (1 - Math.max(0, Math.min(1, v))) * (H - PAD * 2)

  const full = toneCurve(params, 1024)
  const path = `M${Array.from({ length: 65 }, (_, i) => `${x(i / 64).toFixed(1)},${y(full[Math.round((i / 64) * 1023)]).toFixed(1)}`).join('L')}`

  const set = (k: AnchorKey, v: number, group = `curve:${k}`) => onChange(k, clamp(v), group)

  const onPointerDown = (k: AnchorKey) => (e: PointerEvent<SVGCircleElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setDrag({ key: k, y0: e.clientY, v0: value(k) })
  }
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!drag) return
    const h = svg.current?.getBoundingClientRect().height || H
    // the full height of the box is ±100 of offset (±0.5 output) twice over
    set(drag.key, drag.v0 - ((e.clientY - drag.y0) / h) * 200)
  }
  const onKeyDown = (k: AnchorKey) => (e: KeyboardEvent<SVGCircleElement>) => {
    const step = e.shiftKey ? 10 : 1
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') set(k, value(k) + step)
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') set(k, value(k) - step)
    else if (e.key === 'Home' || e.key === 'Delete' || e.key === 'Backspace') set(k, 0, `reset:curve:${k}`)
    else return
    e.preventDefault()
  }

  return (
    <figure className="flex flex-col gap-1">
      <svg
        ref={svg}
        viewBox={`0 0 ${W} ${H}`}
        className="darkroom w-full touch-none select-none rounded-[6px]"
        onPointerMove={onPointerMove}
        onPointerUp={() => setDrag(null)}
        onPointerCancel={() => setDrag(null)}
        role="group"
        aria-label="Tone curve"
      >
        {[0.25, 0.5, 0.75].map((g) => (
          <g key={g} stroke="rgb(244 234 213 / 0.1)">
            <line x1={x(g)} x2={x(g)} y1={PAD} y2={H - PAD} />
            <line y1={y(g)} y2={y(g)} x1={PAD} x2={W - PAD} />
          </g>
        ))}
        <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="rgb(244 234 213 / 0.25)" strokeDasharray="3 3" />
        <path d={path} fill="none" stroke="var(--accent-gold)" strokeWidth={1.8} />
        {ANCHORS.map((a) => {
          const v = value(a.key)
          return (
            <circle
              key={a.key}
              cx={x(a.t)}
              cy={y(a.t + (0.5 * v) / 100)}
              r={drag?.key === a.key ? 7 : 5.5}
              tabIndex={0}
              role="slider"
              aria-label={`Curve ${a.label}`}
              aria-valuemin={-100}
              aria-valuemax={100}
              aria-valuenow={v}
              aria-orientation="vertical"
              fill={v ? 'var(--accent-gold)' : 'var(--on-darkroom)'}
              stroke="var(--darkroom)"
              strokeWidth={1.5}
              className="cursor-ns-resize outline-none focus-visible:stroke-[var(--accent-gold)] focus-visible:[stroke-width:4]"
              onPointerDown={onPointerDown(a.key)}
              onKeyDown={onKeyDown(a.key)}
              onDoubleClick={() => set(a.key, 0, `reset:curve:${a.key}`)}
            >
              <title>{`${a.label}: ${v > 0 ? '+' : ''}${v}`}</title>
            </circle>
          )
        })}
      </svg>
      <figcaption className="text-[12px] text-studio-muted">Drag a point up or down · ↑/↓ when focused · double-click resets</figcaption>
    </figure>
  )
}
