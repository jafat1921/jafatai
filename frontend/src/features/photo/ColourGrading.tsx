import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { DevelopParams, RangeSpec } from '@/lib/photo/types'
import { ParamSlider } from './DevelopTools'

type Zone = 'shadows' | 'midtones' | 'highlights' | 'global'
type OnSet = (key: string, value: number, group: string | null) => void
type OnUpdate = (fn: (p: DevelopParams) => DevelopParams, group: string | null) => void

const ZONES: { id: Zone; label: string }[] = [
  { id: 'shadows', label: 'Shadows' },
  { id: 'midtones', label: 'Midtones' },
  { id: 'highlights', label: 'Highlights' },
  { id: 'global', label: 'Global' },
]

const hueAt = (h: number, s: number) => `hsl(${h} ${Math.round(40 + s * 0.6)}% ${Math.round(60 - s * 0.1)}%)`

/**
 * One hue / saturation disc: the angle is the hue (red at the right, counter-clockwise like
 * Lightroom), the distance from the centre the saturation. Arrows move hue (←/→) and saturation
 * (↑/↓), Shift ×10; double-click resets.
 */
function ColourWheel({ label, h, s, size, onChange }: { label: string; h: number; s: number; size: number; onChange: (h: number, s: number, group: string) => void }) {
  const ref = useRef<SVGSVGElement>(null)
  const [drag, setDrag] = useState(false)
  const r = size / 2 - 4
  const a = (h * Math.PI) / 180
  const px = size / 2 + Math.cos(a) * r * (s / 100)
  const py = size / 2 - Math.sin(a) * r * (s / 100)

  const fromPointer = (e: PointerEvent<SVGSVGElement>) => {
    const b = ref.current?.getBoundingClientRect()
    if (!b) return
    const dx = (e.clientX - b.left) / b.width * size - size / 2
    const dy = size / 2 - (e.clientY - b.top) / b.height * size
    const hue = (Math.round((Math.atan2(dy, dx) * 180) / Math.PI) + 360) % 360
    // Shift holds the hue and changes only the strength, as in Lightroom
    const sat = Math.min(100, Math.round((Math.hypot(dx, dy) / r) * 100))
    onChange(e.shiftKey ? h : hue, sat, `grade:${label}`)
  }
  const onKey = (e: KeyboardEvent<SVGCircleElement>) => {
    const k = e.shiftKey ? 10 : 1
    if (e.key === 'ArrowLeft') onChange((h + 360 - k) % 360, s, `grade:${label}`)
    else if (e.key === 'ArrowRight') onChange((h + k) % 360, s, `grade:${label}`)
    else if (e.key === 'ArrowUp') onChange(h, Math.min(100, s + k), `grade:${label}`)
    else if (e.key === 'ArrowDown') onChange(h, Math.max(0, s - k), `grade:${label}`)
    else if (e.key === 'Delete' || e.key === 'Backspace' || e.key === 'Home') onChange(h, 0, `reset:grade:${label}`)
    else return
    e.preventDefault()
  }

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      className="touch-none select-none"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId)
        setDrag(true)
        fromPointer(e)
      }}
      onPointerMove={(e) => drag && fromPointer(e)}
      onPointerUp={() => setDrag(false)}
      onPointerCancel={() => setDrag(false)}
      onDoubleClick={() => onChange(h, 0, `reset:grade:${label}`)}
    >
      <defs>
        <radialGradient id={`fade-${label}`}>
          <stop offset="0" stopColor="#d8d2c6" stopOpacity="1" />
          <stop offset="1" stopColor="#d8d2c6" stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* conic hue ring drawn as 36 wedges: SVG has no conic gradient */}
      {Array.from({ length: 36 }, (_, i) => {
        const a0 = (i * 10 * Math.PI) / 180
        const a1 = ((i + 1) * 10 * Math.PI) / 180
        const c = size / 2
        return (
          <path
            key={i}
            d={`M${c},${c} L${c + Math.cos(a0) * r},${c - Math.sin(a0) * r} A${r},${r} 0 0 0 ${c + Math.cos(a1) * r},${c - Math.sin(a1) * r} Z`}
            fill={`hsl(${i * 10 + 5} 70% 55%)`}
          />
        )
      })}
      <circle cx={size / 2} cy={size / 2} r={r} fill={`url(#fade-${label})`} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--studio-border-strong, #8a8172)" />
      <circle
        cx={px}
        cy={py}
        r={6}
        tabIndex={0}
        role="slider"
        aria-label={`${label} hue and saturation`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={s}
        aria-valuetext={`hue ${h}°, saturation ${s}`}
        fill={s ? hueAt(h, s) : '#f4ead5'}
        stroke="#2a241c"
        strokeWidth={1.5}
        className="cursor-grab outline-none focus-visible:[stroke-width:3.5]"
        onKeyDown={onKey}
      />
    </svg>
  )
}

/** Lightroom's Color Grading: three wheels (or one at a time), blending and balance. */
export function ColourGrading({ params, ranges, onSet, onUpdate }: { params: DevelopParams; ranges: Record<string, RangeSpec>; onSet: OnSet; onUpdate: OnUpdate }) {
  const [view, setView] = useState<'all' | Zone>('all')
  const zone = (z: Zone) => params.grading?.[z] ?? {}
  const setHS = (z: Zone) => (h: number, s: number, group: string) =>
    onUpdate((p) => ({ ...p, grading: { ...p.grading, [z]: { ...p.grading?.[z], h, s } } }), group)

  const wheel = (z: Zone, size: number) => {
    const { h = 0, s = 0 } = zone(z)
    const label = ZONES.find((x) => x.id === z)!.label
    return (
      <figure key={z} className="flex flex-col items-center gap-1">
        <ColourWheel label={label} h={h} s={s} size={size} onChange={setHS(z)} />
        <figcaption className="text-[12px] text-studio-muted">{label}</figcaption>
      </figure>
    )
  }

  return (
    <div className="flex flex-col gap-2.5">
      <ToggleGroup type="single" value={view} onValueChange={(v) => v && setView(v as typeof view)} aria-label="Colour grading view" className="w-full">
        <ToggleGroupItem value="all" className="px-2 text-small">3-way</ToggleGroupItem>
        {ZONES.map((z) => (
          <ToggleGroupItem key={z.id} value={z.id} className="px-1.5 text-small" title={z.label}>
            {z.label.slice(0, z.id === 'global' ? 6 : 4)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {view === 'all' ? (
        <>
          <div className="flex justify-center">{wheel('midtones', 104)}</div>
          <div className="flex justify-between">{wheel('shadows', 96)}{wheel('highlights', 96)}</div>
          {(['shadows', 'midtones', 'highlights'] as const).map((z) => (
            <ParamSlider key={z} k={`grading.${z}.l`} params={params} ranges={ranges} onSet={onSet} label={`${ZONES.find((x) => x.id === z)!.label} luminance`} />
          ))}
        </>
      ) : (
        <>
          <div className="flex justify-center">{wheel(view, 168)}</div>
          <ParamSlider k={`grading.${view}.h`} params={params} ranges={ranges} onSet={onSet} track="linear-gradient(90deg, hsl(0 70% 55%), hsl(60 70% 55%), hsl(120 70% 55%), hsl(180 70% 55%), hsl(240 70% 55%), hsl(300 70% 55%), hsl(360 70% 55%))" />
          <ParamSlider k={`grading.${view}.s`} params={params} ranges={ranges} onSet={onSet} />
          <ParamSlider k={`grading.${view}.l`} params={params} ranges={ranges} onSet={onSet} />
        </>
      )}
      <ParamSlider k="grading.blending" params={params} ranges={ranges} onSet={onSet} />
      <ParamSlider k="grading.balance" params={params} ranges={ranges} onSet={onSet} />
    </div>
  )
}
