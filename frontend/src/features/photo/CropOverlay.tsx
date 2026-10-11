import { useState, type KeyboardEvent, type PointerEvent } from 'react'
import { clampCrop, straightenAngle } from '@/lib/photo/geometry'
import { overlayLines, type CropOverlayKind } from '@/lib/photo/cropOverlays'
import type { Crop } from '@/lib/photo/types'

type Corner = 'nw' | 'ne' | 'sw' | 'se'

interface Props {
  crop: Crop
  src: { w: number; h: number }
  box: { width: number; height: number }
  // width / height to hold, or null for free
  ratio: number | null
  onChange: (crop: Crop, group: string) => void
  overlay?: CropOverlayKind
  // Shift+O: 0..3, flips the asymmetric overlays (triangle, spiral) left/right and up/down
  orient?: number
  // how dark the area outside the crop is, 0..1
  opacity?: number
}

const CORNERS: { id: Corner; label: string; cls: string }[] = [
  { id: 'nw', label: 'top-left', cls: '-left-2 -top-2 cursor-nwse-resize' },
  { id: 'ne', label: 'top-right', cls: '-right-2 -top-2 cursor-nesw-resize' },
  { id: 'sw', label: 'bottom-left', cls: '-bottom-2 -left-2 cursor-nesw-resize' },
  { id: 'se', label: 'bottom-right', cls: '-bottom-2 -right-2 cursor-nwse-resize' },
]

function OverlayArt({ kind, orient, aspect }: { kind: CropOverlayKind; orient: number; aspect: number }) {
  if (kind === 'none') return null
  const { lines, path } = overlayLines(kind, aspect)
  const fx = orient & 1 ? -1 : 1
  const fy = orient & 2 ? -1 : 1
  return (
    <svg aria-hidden className="pointer-events-none absolute inset-0 size-full" viewBox="0 0 1 1" preserveAspectRatio="none">
      <g transform={`translate(${fx < 0 ? 1 : 0} ${fy < 0 ? 1 : 0}) scale(${fx} ${fy})`} className="stroke-studio-on-dark/45" fill="none" strokeWidth={1} vectorEffect="non-scaling-stroke">
        {lines.map(([x1, y1, x2, y2], i) => <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} vectorEffect="non-scaling-stroke" />)}
        {path && <path d={path} vectorEffect="non-scaling-stroke" />}
      </g>
    </svg>
  )
}

/**
 * Crop box over the uncropped source. Drag inside to move, drag a corner to resize (holding the
 * chosen aspect). Keyboard: focus the box and use the arrows to move, Shift for bigger steps;
 * a focused corner resizes with the arrows.
 */
export function CropOverlay({ crop, src, box, ratio, onChange, overlay = 'thirds', orient = 0, opacity = 0.6 }: Props) {
  const [drag, setDrag] = useState<{ what: Corner | 'move'; x: number; y: number; start: Crop } | null>(null)
  const k = box.width / src.w
  const step = (e: KeyboardEvent) => Math.max(1, Math.round(Math.max(src.w, src.h) * (e.shiftKey ? 0.05 : 0.005)))

  const resize = (start: Crop, corner: Corner, dx: number, dy: number): Crop => {
    let { x, y, width, height } = start
    const west = corner === 'nw' || corner === 'sw'
    const north = corner === 'nw' || corner === 'ne'
    width = west ? width - dx : width + dx
    height = ratio ? width / ratio : north ? height - dy : height + dy
    if (west) x = start.x + start.width - width
    if (north) y = start.y + start.height - height
    return { x, y, width, height }
  }

  const apply = (c: Crop, group: string) => {
    const safe = clampCrop(c, src.w, src.h)
    // with a fixed aspect, clamping one side must not stretch the other
    if (ratio && Math.abs(safe.width / safe.height - ratio) > 0.01) return
    onChange(safe, group)
  }

  const onDown = (what: Corner | 'move') => (e: PointerEvent<HTMLElement>) => {
    e.stopPropagation()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setDrag({ what, x: e.clientX, y: e.clientY, start: crop })
  }
  const onMove = (e: PointerEvent<HTMLElement>) => {
    if (!drag) return
    const dx = (e.clientX - drag.x) / k
    const dy = (e.clientY - drag.y) / k
    if (drag.what === 'move') apply({ ...drag.start, x: drag.start.x + dx, y: drag.start.y + dy }, 'crop')
    else apply(resize(drag.start, drag.what, dx, dy), 'crop')
  }

  const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
  const onKey = (what: Corner | 'move') => (e: KeyboardEvent<HTMLElement>) => {
    const d = ARROWS[e.key]
    if (!d) return
    e.preventDefault()
    e.stopPropagation()
    const s = step(e)
    if (what === 'move') apply({ ...crop, x: crop.x + d[0] * s, y: crop.y + d[1] * s }, 'crop-key')
    else apply(resize(crop, what, d[0] * s, d[1] * s), 'crop-key')
  }

  return (
    <div
      role="group"
      aria-label="Crop"
      className="absolute touch-none border border-studio-gold"
      style={{
        left: crop.x * k, top: crop.y * k, width: crop.width * k, height: crop.height * k,
        boxShadow: `0 0 0 9999px rgb(10 7 4 / ${Math.max(0, Math.min(1, opacity))})`,
      }}
      onPointerMove={onMove}
      onPointerUp={() => setDrag(null)}
      onPointerCancel={() => setDrag(null)}
    >
      <div
        tabIndex={0}
        role="button"
        aria-label={`Crop area ${crop.width} by ${crop.height} pixels. Arrow keys move it.`}
        className="absolute inset-0 cursor-move outline-none focus-visible:ring-2 focus-visible:ring-studio-gold"
        onPointerDown={onDown('move')}
        onKeyDown={onKey('move')}
      >
        <OverlayArt kind={overlay} orient={orient} aspect={crop.width / Math.max(1, crop.height)} />
      </div>
      {CORNERS.map((c) => (
        <button
          key={c.id}
          type="button"
          aria-label={`Resize crop from the ${c.label} corner`}
          className={`absolute size-4 rounded-[2px] border-2 border-studio-darkroom bg-studio-gold ${c.cls}`}
          onPointerDown={onDown(c.id)}
          onKeyDown={onKey(c.id)}
        />
      ))}
    </div>
  )
}

/** Straighten tool: drag along something that should be level (or plumb); letting go sets the angle. */
export function StraightenOverlay({ src, box, onAngle }: { src: { w: number; h: number }; box: { width: number; height: number }; onAngle: (deg: number) => void }) {
  const [line, setLine] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const k = box.width / src.w
  const at = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k }
  }
  return (
    <div
      role="application"
      aria-label="Straighten: drag along a line that should be level"
      className="absolute inset-0 cursor-crosshair touch-none"
      onPointerDown={(e) => {
        e.stopPropagation()
        e.currentTarget.setPointerCapture?.(e.pointerId)
        const p = at(e)
        setLine({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
      }}
      onPointerMove={(e) => {
        if (!line) return
        const p = at(e)
        setLine({ ...line, x1: p.x, y1: p.y })
      }}
      onPointerUp={() => {
        if (line) {
          const a = straightenAngle(line.x0, line.y0, line.x1, line.y1)
          if (a != null) onAngle(a)
        }
        setLine(null)
      }}
      onPointerCancel={() => setLine(null)}
    >
      {line && (
        <svg aria-hidden className="pointer-events-none absolute inset-0 size-full">
          <line x1={line.x0 * k} y1={line.y0 * k} x2={line.x1 * k} y2={line.y1 * k} className="stroke-studio-gold" strokeWidth={2} strokeDasharray="6 4" />
        </svg>
      )}
    </div>
  )
}
