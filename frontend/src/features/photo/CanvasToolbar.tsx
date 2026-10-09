import { useRef, useState, type PointerEvent } from 'react'
import { Grid3x3, Info, SquareSplitHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Zoom } from './DarkroomCanvas'
import { COMPARE, GRIDS, ratioZoom, type CompareMode } from '@/lib/photo/view'

interface Props {
  compare: CompareMode
  onCompare: (m: CompareMode) => void
  before: boolean
  onBefore: () => void
  zoom: Zoom
  onZoom: (z: Zoom) => void
  grid: number
  onGrid: (n: number) => void
  info: boolean
  onInfo: () => void
}

const btn = (on: boolean) => cn('flex h-7 items-center gap-1 rounded-[6px] px-2 text-small focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-studio-accent', on ? 'bg-studio-accent text-studio-accent-fg' : 'hover:bg-studio-panel-hover')

/** Lightroom's Develop toolbar under the photo: before/after modes, zoom, grid overlay, info overlay. */
export function CanvasToolbar({ compare, onCompare, before, onBefore, zoom, onZoom, grid, onGrid, info, onInfo }: Props) {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const is = (scale: number) => typeof zoom === 'number' && Math.abs(zoom - scale / dpr) < 1e-3
  return (
    <div role="toolbar" aria-label="View" className="flex flex-wrap items-center gap-1.5 border-t border-studio-border bg-studio-panel px-2 py-1">
      <label className="flex items-center gap-1 text-small">
        <SquareSplitHorizontal aria-hidden className="size-4 text-studio-muted" />
        <span className="sr-only">Before and after</span>
        <select value={compare} onChange={(e) => onCompare(e.target.value as CompareMode)} className="h-7 rounded-[6px] border border-studio-border-strong bg-studio-raised px-1.5">
          {COMPARE.map((c) => <option key={c.id} value={c.id}>{c.label}{c.key ? ` (${c.key})` : ''}</option>)}
        </select>
      </label>
      <button type="button" aria-pressed={before} title="Before only (\\)" onClick={onBefore} className={btn(before)}>Before</button>
      <span aria-hidden className="mx-1 h-5 w-px bg-studio-border" />
      <div role="group" aria-label="Zoom" className="flex gap-0.5">
        <button type="button" aria-pressed={zoom === 'fit'} onClick={() => onZoom('fit')} className={btn(zoom === 'fit')}>Fit</button>
        <button type="button" aria-pressed={zoom === 'fill'} onClick={() => onZoom('fill')} className={btn(zoom === 'fill')}>Fill</button>
        <button type="button" aria-pressed={is(1)} title="100% (Z)" onClick={() => onZoom(ratioZoom(1))} className={btn(is(1))}>1:1</button>
        <button type="button" aria-pressed={is(2)} onClick={() => onZoom(ratioZoom(2))} className={btn(is(2))}>2:1</button>
      </div>
      <span aria-hidden className="mx-1 h-5 w-px bg-studio-border" />
      <label className="flex items-center gap-1 text-small" title="Grid overlay (Ctrl+Alt+O)">
        <Grid3x3 aria-hidden className="size-4 text-studio-muted" />
        <span className="sr-only">Grid overlay</span>
        <select value={grid} onChange={(e) => onGrid(Number(e.target.value))} className="h-7 rounded-[6px] border border-studio-border-strong bg-studio-raised px-1.5">
          {GRIDS.map((n) => <option key={n} value={n}>{n === 0 ? 'No grid' : n === 3 ? 'Thirds' : `${n} × ${n}`}</option>)}
        </select>
      </label>
      <button type="button" aria-pressed={info} title="Info overlay (I)" onClick={onInfo} className={btn(info)}>
        <Info aria-hidden className="size-4" /> Info
      </button>
    </div>
  )
}

/** The unedited frame over the edit, cut at a draggable line (Shift+Y). */
export function SplitOverlay({ src, vertical, box }: { src: string; vertical: boolean; box: { width: number; height: number } }) {
  const [at, setAt] = useState(0.5)
  const drag = useRef(false)
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    const r = e.currentTarget.getBoundingClientRect()
    setAt(Math.min(1, Math.max(0, vertical ? (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width)))
  }
  const clip = vertical ? `inset(0 0 ${(1 - at) * 100}% 0)` : `inset(0 ${(1 - at) * 100}% 0 0)`
  return (
    <div className="absolute inset-0" onPointerMove={move} onPointerUp={() => (drag.current = false)} style={{ width: box.width, height: box.height }}>
      <img src={src} alt="Before" className="pointer-events-none absolute inset-0 size-full" style={{ clipPath: clip }} draggable={false} />
      <div
        role="slider"
        tabIndex={0}
        aria-label="Before and after divider"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(at * 100)}
        onPointerDown={(e) => {
          e.stopPropagation()
          drag.current = true
          e.currentTarget.parentElement?.setPointerCapture?.(e.pointerId)
        }}
        onKeyDown={(e) => {
          const d = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -0.05 : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 0.05 : 0
          if (d) {
            e.preventDefault()
            setAt((a) => Math.min(1, Math.max(0, a + d)))
          }
        }}
        className={cn('absolute bg-studio-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white', vertical ? 'inset-x-0 h-0.5 cursor-row-resize' : 'inset-y-0 w-0.5 cursor-col-resize')}
        style={vertical ? { top: `${at * 100}%` } : { left: `${at * 100}%` }}
      />
      <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/55 px-1.5 text-[11px] text-white">Before</span>
      <span className="pointer-events-none absolute bottom-2 right-2 rounded bg-black/55 px-1.5 text-[11px] text-white">After</span>
    </div>
  )
}

export function GridOverlay({ n, box }: { n: number; box: { width: number; height: number } }) {
  if (!n) return null
  const lines = Array.from({ length: n - 1 }, (_, i) => (i + 1) / n)
  return (
    <svg aria-hidden className="pointer-events-none absolute inset-0" width={box.width} height={box.height}>
      {lines.map((f) => (
        <g key={f} stroke="rgb(255 255 255 / 0.55)" strokeWidth={1} shapeRendering="crispEdges">
          <line x1={f * box.width} x2={f * box.width} y1={0} y2={box.height} />
          <line y1={f * box.height} y2={f * box.height} x1={0} x2={box.width} />
        </g>
      ))}
    </svg>
  )
}

export function InfoOverlay({ lines }: { lines: string[] }) {
  return (
    <div className="pointer-events-none absolute left-3 top-3 max-w-[70%] rounded-[6px] bg-black/55 px-2.5 py-1.5 text-small text-white">
      {lines.filter(Boolean).map((l, i) => <div key={i} className={i ? 'text-[12px] text-white/80' : 'font-medium'}>{l}</div>)}
    </div>
  )
}
