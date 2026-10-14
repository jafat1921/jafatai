import { useId, useRef, useState } from 'react'
import { Eraser, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useMediaItem } from '@/hooks/useMedia'
import { mediaAlt } from '@/lib/media'

const LONG_SIDE = 1024 // the server scales the mask to the photo, so the canvas only needs the shape
const INK = '#b4532a'

function canvasSize(w?: number | null, h?: number | null): [number, number] {
  if (!w || !h) return [LONG_SIDE, LONG_SIDE]
  const s = LONG_SIDE / Math.max(w, h)
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))]
}

/**
 * Paint over what should go. Key it by the photo: a new photo starts a new mask. Exports a transparent PNG with opaque strokes (the server reads the alpha).
 * Pointer only; the hint names the keyboard-friendly routes (a Photo Studio selection, or words).
 */
export function MaskBrush({ sourceId, onChange }: { sourceId: string; onChange: (mask: string | null) => void }) {
  const uid = useId()
  const q = useMediaItem(sourceId)
  const m = q.data
  const [w, h] = canvasSize(m?.width, m?.height)
  const canvas = useRef<HTMLCanvasElement>(null)
  const last = useRef<{ x: number; y: number } | null>(null)
  const history = useRef<ImageData[]>([])
  const [size, setSize] = useState(40)
  const [strokes, setStrokes] = useState(0)

  const ctx = () => canvas.current?.getContext('2d') ?? null

  const at = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / Math.max(1, r.width)) * w, y: ((e.clientY - r.top) / Math.max(1, r.height)) * h }
  }

  const dab = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const c = ctx()
    if (!c) return
    c.strokeStyle = INK
    c.fillStyle = INK
    c.lineCap = 'round'
    c.lineJoin = 'round'
    c.lineWidth = size
    c.beginPath()
    c.moveTo(from.x, from.y)
    c.lineTo(to.x, to.y)
    c.stroke()
  }

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = ctx()
    if (!c) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    history.current.push(c.getImageData(0, 0, w, h))
    if (history.current.length > 20) history.current.shift()
    const p = at(e)
    last.current = p
    dab(p, p)
  }

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!last.current) return
    const p = at(e)
    dab(last.current, p)
    last.current = p
  }

  const up = () => {
    if (!last.current) return
    last.current = null
    setStrokes((n) => n + 1)
    onChange(canvas.current?.toDataURL('image/png') ?? null)
  }

  const undo = () => {
    const c = ctx()
    const prev = history.current.pop()
    if (!c || !prev) return
    c.putImageData(prev, 0, 0)
    const left = strokes - 1
    setStrokes(left)
    onChange(left > 0 ? (canvas.current?.toDataURL('image/png') ?? null) : null)
  }

  const clear = () => {
    ctx()?.clearRect(0, 0, w, h)
    history.current = []
    setStrokes(0)
    onChange(null)
  }

  const src = m?.media_url ?? m?.thumb_url
  return (
    <div className="flex flex-col gap-2" role="group" aria-labelledby={`${uid}-label`}>
      <span id={`${uid}-label`} className="section-label">
        Paint over what should go
      </span>
      <div className="relative w-full max-w-md overflow-hidden rounded-[6px] border border-studio-border-strong bg-studio-raised" style={{ aspectRatio: `${w} / ${h}` }}>
        {src ? <img src={src} alt={m ? mediaAlt(m) : 'Photo'} className="absolute inset-0 size-full object-fill" draggable={false} /> : <Skeleton className="absolute inset-0" />}
        <canvas
          ref={canvas}
          width={w}
          height={h}
          aria-label="Mask: drag over the object to remove"
          aria-describedby={`${uid}-hint`}
          className="absolute inset-0 size-full cursor-crosshair touch-none opacity-60"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onPointerLeave={up}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor={`${uid}-size`} className="flex items-center gap-2 text-small">
          Brush
          <input id={`${uid}-size`} type="range" min={8} max={160} step={4} value={size} onChange={(e) => setSize(Number(e.target.value))} className="w-32 accent-studio-accent" />
        </label>
        <Button type="button" size="sm" variant="ghost" onClick={undo} disabled={!strokes}>
          <Undo2 aria-hidden />
          Undo
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={clear} disabled={!strokes}>
          <Eraser aria-hidden />
          Clear mask
        </Button>
        <span className="text-small text-studio-muted" role="status">
          {strokes ? `${strokes} ${strokes === 1 ? 'stroke' : 'strokes'} painted` : 'Nothing painted yet'}
        </span>
      </div>
      <p id={`${uid}-hint`} className="text-[12px] text-studio-muted">
        Cover the whole object with a little margin. No pointer? Pick a selection made in Photo Studio (Cut-out, Select by words) as the photo, or leave the mask empty and name the object; the edit model then removes it.
      </p>
    </div>
  )
}
