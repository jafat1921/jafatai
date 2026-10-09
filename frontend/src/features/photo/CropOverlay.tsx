import { useState, type KeyboardEvent, type PointerEvent } from 'react'
import { clampCrop } from '@/lib/photo/geometry'
import type { Crop } from '@/lib/photo/types'

type Corner = 'nw' | 'ne' | 'sw' | 'se'

interface Props {
  crop: Crop
  src: { w: number; h: number }
  box: { width: number; height: number }
  // width / height to hold, or null for free
  ratio: number | null
  onChange: (crop: Crop, group: string) => void
}

const CORNERS: { id: Corner; label: string; cls: string }[] = [
  { id: 'nw', label: 'top-left', cls: '-left-2 -top-2 cursor-nwse-resize' },
  { id: 'ne', label: 'top-right', cls: '-right-2 -top-2 cursor-nesw-resize' },
  { id: 'sw', label: 'bottom-left', cls: '-bottom-2 -left-2 cursor-nesw-resize' },
  { id: 'se', label: 'bottom-right', cls: '-bottom-2 -right-2 cursor-nwse-resize' },
]

/**
 * Crop box over the uncropped source. Drag inside to move, drag a corner to resize (holding the
 * chosen aspect). Keyboard: focus the box and use the arrows to move, Shift for bigger steps;
 * a focused corner resizes with the arrows.
 */
export function CropOverlay({ crop, src, box, ratio, onChange }: Props) {
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
      className="absolute touch-none border border-studio-gold shadow-[0_0_0_9999px_rgb(10_7_4/0.6)]"
      style={{ left: crop.x * k, top: crop.y * k, width: crop.width * k, height: crop.height * k }}
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
        {/* rule of thirds */}
        <div aria-hidden className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3">
          {Array.from({ length: 9 }, (_, i) => (
            <span key={i} className="border-[0.5px] border-studio-on-dark/25" />
          ))}
        </div>
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
