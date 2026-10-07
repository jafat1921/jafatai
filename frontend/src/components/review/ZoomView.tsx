import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react'
import { ZoomIn, ZoomOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface ZoomImage {
  url: string
  alt: string
  label?: string
}
export type CompareMode = 'off' | 'side' | 'swipe'

interface View {
  s: number
  x: number
  y: number
}
const MIN = 1
const MAX = 8
const STEP = 1.25
const HOME: View = { s: 1, x: 0, y: 0 }

// keep the picture covering its pane: at scale s it may slide (s-1)/2 of the pane each way
function clampView(v: View, w: number, h: number): View {
  const s = Math.min(MAX, Math.max(MIN, v.s))
  const mx = ((s - 1) * w) / 2
  const my = ((s - 1) * h) / 2
  return { s, x: Math.max(-mx, Math.min(mx, v.x)), y: Math.max(-my, Math.min(my, v.y)) }
}

/**
 * Zoom/pan for still images (wheel, pinch, drag, + / − / 0 and arrows when focused). With a second
 * image it compares side by side or with a swipe, both at the same zoom so detail lines up.
 * Key it by the image so a new version starts unzoomed.
 */
export function ZoomView({
  image,
  other,
  mode = 'off',
  className,
}: {
  image: ZoomImage
  other?: ZoomImage
  mode?: CompareMode
  className?: string
}) {
  const [view, setView] = useState<View>(HOME)
  const [dragging, setDragging] = useState(false)
  const [swipe, setSwipe] = useState(50)
  const root = useRef<HTMLDivElement>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<number | null>(null)
  const compare = other && mode !== 'off' ? mode : 'off'

  const paneSize = useCallback(() => {
    const el = root.current?.querySelector<HTMLElement>('[data-pane]')
    return { w: el?.clientWidth || 1, h: el?.clientHeight || 1 }
  }, [])

  // zoom about a point given relative to the pane centre, so what's under the cursor stays put
  const zoomAt = useCallback(
    (factor: number, px = 0, py = 0) => {
      const { w, h } = paneSize()
      setView((v) => {
        const s = Math.min(MAX, Math.max(MIN, v.s * factor))
        const k = s / v.s
        return clampView({ s, x: px - (px - v.x) * k, y: py - (py - v.y) * k }, w, h)
      })
    },
    [paneSize],
  )
  const panBy = useCallback(
    (dx: number, dy: number) => {
      const { w, h } = paneSize()
      setView((v) => clampView({ ...v, x: v.x + dx, y: v.y + dy }, w, h))
    },
    [paneSize],
  )
  const reset = () => setView(HOME)

  // React's onWheel is passive, and the page mustn't scroll while zooming
  useEffect(() => {
    const el = root.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const pane = (e.target as HTMLElement).closest<HTMLElement>('[data-pane]')
      if (!pane) return
      e.preventDefault()
      const r = pane.getBoundingClientRect()
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  const onPointerDown = (e: RPointerEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('button,input')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    setDragging(true)
  }
  const onPointerMove = (e: RPointerEvent<HTMLElement>) => {
    const prev = pointers.current.get(e.pointerId)
    if (!prev) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const pts = [...pointers.current.values()]
    if (pts.length === 2) {
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
      if (pinch.current) {
        const r = e.currentTarget.getBoundingClientRect()
        const cx = (pts[0].x + pts[1].x) / 2 - r.left - r.width / 2
        const cy = (pts[0].y + pts[1].y) / 2 - r.top - r.height / 2
        zoomAt(d / pinch.current, cx, cy)
      }
      pinch.current = d
    } else {
      panBy(e.clientX - prev.x, e.clientY - prev.y)
    }
  }
  const onPointerUp = (e: RPointerEvent<HTMLElement>) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    if (!pointers.current.size) setDragging(false)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const step = 40
    const keys: Record<string, () => void> = {
      '+': () => zoomAt(STEP),
      '=': () => zoomAt(STEP),
      '-': () => zoomAt(1 / STEP),
      '0': reset,
      ArrowLeft: () => panBy(step, 0),
      ArrowRight: () => panBy(-step, 0),
      ArrowUp: () => panBy(0, step),
      ArrowDown: () => panBy(0, -step),
    }
    const fn = keys[e.key]
    if (!fn || (e.key.startsWith('Arrow') && view.s === 1)) return
    e.preventDefault()
    e.stopPropagation()
    fn()
  }

  const style: CSSProperties = {
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
    transition: dragging ? 'none' : 'transform 120ms ease-out',
  }
  const imgClass = 'pointer-events-none size-full select-none object-contain'
  const pct = Math.round(view.s * 100)
  const paneProps = {
    'data-pane': true,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    className: cn('relative h-full min-w-0 flex-1 touch-none overflow-hidden', view.s > 1 && (dragging ? 'cursor-grabbing' : 'cursor-grab')),
  }

  return (
    <div
      ref={root}
      role="group"
      tabIndex={0}
      aria-label={`${image.alt}. Zoom ${pct}%. Plus and minus zoom, 0 resets, arrow keys pan.`}
      aria-keyshortcuts="+ - 0"
      onKeyDown={onKeyDown}
      className={cn('relative flex size-full gap-px focus-visible:outline-2 focus-visible:outline-[var(--accent)]', className)}
    >
      {compare === 'side' && other ? (
        <>
          <div {...paneProps}>
            <img src={other.url} alt={other.alt} draggable={false} className={imgClass} style={style} />
            <PaneTag>{other.label}</PaneTag>
          </div>
          <div {...paneProps}>
            <img src={image.url} alt={image.alt} draggable={false} className={imgClass} style={style} />
            <PaneTag>{image.label}</PaneTag>
          </div>
        </>
      ) : (
        <div {...paneProps}>
          <img
            src={compare === 'swipe' && other ? other.url : image.url}
            alt={compare === 'swipe' && other ? other.alt : image.alt}
            draggable={false}
            className={cn(imgClass, 'animate-fade-in')}
            style={style}
          />
          {compare === 'swipe' && other && (
            <>
              <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${swipe}%)` }}>
                <img src={image.url} alt={image.alt} draggable={false} className={imgClass} style={style} />
              </div>
              <div aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-[var(--accent-gold)]" style={{ left: `${swipe}%` }} />
              <PaneTag side="left">{other.label}</PaneTag>
              <PaneTag>{image.label}</PaneTag>
              <input
                type="range"
                min={0}
                max={100}
                value={swipe}
                onChange={(e) => setSwipe(Number(e.target.value))}
                aria-label="Swipe between the two versions"
                className="absolute inset-x-3 bottom-11 h-6 cursor-ew-resize accent-[var(--accent-gold)]"
              />
            </>
          )}
        </div>
      )}

      <div className="absolute bottom-2 right-2 flex items-center gap-0.5 rounded-[6px] bg-studio-raised/90 p-0.5 backdrop-blur">
        <Button size="icon-sm" variant="ghost" aria-label="Zoom out (−)" disabled={view.s <= MIN} onClick={() => zoomAt(1 / STEP)}>
          <ZoomOut aria-hidden />
        </Button>
        <Button size="sm" variant="ghost" className="w-14 font-mono" aria-label={`Reset zoom (0), now ${pct}%`} onClick={reset}>
          {pct}%
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Zoom in (+)" disabled={view.s >= MAX} onClick={() => zoomAt(STEP)}>
          <ZoomIn aria-hidden />
        </Button>
      </div>
    </div>
  )
}

function PaneTag({ children, side = 'right' }: { children?: React.ReactNode; side?: 'left' | 'right' }) {
  if (!children) return null
  return (
    <span
      className={cn(
        'pointer-events-none absolute top-2 rounded-[4px] bg-studio-raised/90 px-1.5 py-0.5 text-small font-medium text-studio-text backdrop-blur',
        side === 'right' ? 'right-2' : 'left-2 top-10',
      )}
    >
      {children}
    </span>
  )
}
