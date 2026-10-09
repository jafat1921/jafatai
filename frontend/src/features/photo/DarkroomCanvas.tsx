import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode, type WheelEvent } from 'react'
import { Check, Loader2, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { LivePreview } from './useLivePreview'

export type Zoom = 'fit' | 'fill' | number

export interface CanvasView {
  scale: number
  fit: number
  box: { w: number; h: number }
  frame: { width: number; height: number }
  off: { x: number; y: number }
}

interface Props {
  preview: LivePreview
  // the live preview's canvas hook-up (kept apart so the compiler doesn't treat `preview` as a ref)
  attach: (el: HTMLCanvasElement | null) => void
  sourceUrl: string | null
  alt: string
  before: boolean
  zoom: Zoom
  onZoom: (z: Zoom) => void
  onMaxSide: (px: number) => void
  // crop / light-point layers, drawn in frame pixels over the picture
  overlay?: (box: { width: number; height: number }) => ReactNode
  // the overlay owns the pointer (crop, placing points): no panning
  overlayActive?: boolean
  // pan lives with the page so the Navigator can show and move it
  pan: { x: number; y: number }
  onPan: (p: { x: number; y: number }) => void
  onView?: (v: CanvasView) => void
  // pointer position over the picture, 0..1 of the frame (RGB readout); null when it leaves
  onSample?: (at: { x: number; y: number } | null) => void
}

const FALLBACK = { w: 900, h: 600 }

/** The darkroom: the developed frame, fitted or zoomed (1:1 with L), panned by dragging when zoomed. */
export function DarkroomCanvas({ preview, attach, sourceUrl, alt, before, zoom, onZoom, onMaxSide, overlay, overlayActive, pan, onPan: setPan, onView, onSample }: Props) {
  const wrap = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState(FALLBACK)
  const [drag, setDrag] = useState<{ x: number; y: number; px: number; py: number } | null>(null)

  useEffect(() => {
    const el = wrap.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => {
      const r = e.contentRect
      if (r.width > 0 && r.height > 0) setBox({ w: r.width, h: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const frame = preview.frame ?? { width: 3, height: 2 }
  const fit = Math.min((box.w - 24) / frame.width, (box.h - 24) / frame.height)
  const fill = Math.max(box.w / frame.width, box.h / frame.height)
  const scale = zoom === 'fit' ? fit : zoom === 'fill' ? fill : zoom
  const w = Math.max(1, frame.width * scale)
  const h = Math.max(1, frame.height * scale)
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const maxSide = Math.ceil(Math.max(w, h) * dpr)

  useEffect(() => onMaxSide(maxSide), [maxSide, onMaxSide])

  const zoomed = zoom !== 'fit'
  // panning stays within reach of the picture's edges
  const limit = { x: Math.max(0, (w - box.w) / 2 + 40), y: Math.max(0, (h - box.h) / 2 + 40) }
  const off = zoomed ? { x: Math.max(-limit.x, Math.min(limit.x, pan.x)), y: Math.max(-limit.y, Math.min(limit.y, pan.y)) } : { x: 0, y: 0 }

  useEffect(() => {
    onView?.({ scale, fit, box, frame, off })
    // the numbers are what matter; the objects are new every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, fit, box.w, box.h, frame.width, frame.height, off.x, off.y])

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (!zoomed || overlayActive || e.button !== 0) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setDrag({ x: e.clientX, y: e.clientY, px: off.x, py: off.y })
  }
  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (drag) setPan({ x: drag.px + e.clientX - drag.x, y: drag.py + e.clientY - drag.y })
    if (onSample && wrap.current) {
      const r = wrap.current.getBoundingClientRect()
      const x = (e.clientX - r.left - (r.width - w) / 2 - off.x) / w
      const y = (e.clientY - r.top - (r.height - h) / 2 - off.y) / h
      onSample(x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null)
    }
  }
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (!e.ctrlKey && !e.metaKey) return
    const next = Math.max(fit * 0.5, Math.min(8, scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
    onZoom(next)
  }

  const showServer = !before && (preview.mode === 'server' ? !!preview.server : preview.exact)
  const showOriginal = before && preview.mode === 'server'

  return (
    <div
      ref={wrap}
      className={cn('darkroom relative size-full min-h-0 overflow-hidden', zoomed && !overlayActive && (drag ? 'cursor-grabbing' : 'cursor-grab'))}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => setDrag(null)}
      onPointerCancel={() => setDrag(null)}
      onPointerLeave={() => onSample?.(null)}
      onWheel={onWheel}
    >
      <div
        className="absolute left-1/2 top-1/2"
        style={{ width: w, height: h, transform: `translate(calc(-50% + ${off.x}px), calc(-50% + ${off.y}px))` }}
      >
        <canvas
          ref={attach}
          role="img"
          aria-label={before ? `${alt}, before editing` : `${alt}, live preview`}
          className={cn('absolute inset-0 size-full', (preview.mode !== 'webgl' || showServer) && 'invisible')}
        />
        {showServer && preview.server && <img src={preview.server.url} alt={`${alt}, exact preview`} className="absolute inset-0 size-full" draggable={false} />}
        {showOriginal && sourceUrl && <img src={sourceUrl} alt={`${alt}, before editing`} className="absolute inset-0 size-full object-contain" draggable={false} />}
        {overlay?.({ width: w, height: h })}
      </div>

      {preview.sourceError && preview.mode === 'webgl' && (
        <p role="alert" className="absolute inset-x-4 top-4 rounded-[6px] bg-studio-danger/90 px-3 py-2 text-small text-studio-on-dark">
          {preview.sourceError}
        </p>
      )}
      <PreviewBadge preview={preview} before={before} />
      {zoomed && (
        <span className="absolute bottom-3 left-3 rounded-[4px] bg-studio-darkroom/85 px-2 py-0.5 font-mono text-small text-studio-on-dark">
          {Math.round(scale * 100)}%
        </span>
      )}
    </div>
  )
}

function PreviewBadge({ preview, before }: { preview: LivePreview; before: boolean }) {
  let content: ReactNode
  if (before) content = 'Before'
  else if (preview.mode === 'server' && !preview.exact) {
    content = (
      <>
        <Loader2 aria-hidden className="size-3 motion-safe:animate-spin" /> Server preview · updating
      </>
    )
  } else if (preview.exact) {
    content = (
      <>
        <Check aria-hidden className="size-3" /> Exact preview
        {preview.server?.ms ? <span className="text-studio-on-dark-muted"> · {Math.round(preview.server.ms)} ms</span> : null}
      </>
    )
  } else if (preview.approximate) {
    content = (
      <>
        <Loader2 aria-hidden className="size-3 motion-safe:animate-spin" /> Live · refining detail
      </>
    )
  } else {
    content = (
      <>
        <Sparkles aria-hidden className="size-3" /> Live preview
      </>
    )
  }
  return (
    // not a live region: it flips with every slider move and would chatter
    <span
      className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full bg-studio-darkroom/85 px-2 py-0.5 text-small text-studio-on-dark"
    >
      {content}
    </span>
  )
}
