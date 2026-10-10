import { useEffect, useId, useRef, useState } from 'react'
import { clamp, clampView, MIN_REGION_S, stamp, zoomView, type View } from '@/lib/audio-edit'
import type { AudioMarker, TimeRegion } from '@/lib/types'
import { cn } from '@/lib/utils'
import { drawPeaks, prepare, token, useSize } from '../waveDraw'

const STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
const tickStep = (span: number, width: number) => STEPS.find((s) => (width / span) * s >= 70) ?? 600

interface Props {
  peaks: [number, number][] | null
  duration: number
  view: View
  onView: (v: View) => void
  playhead: number
  onSeek: (t: number) => void
  selection: TimeRegion | null
  onSelect: (r: TimeRegion | null) => void
  trim?: TimeRegion | null
  cuts: TimeRegion[]
  markers: AudioMarker[]
  // what the screen reader hears about the picture
  summary: string
}

type Drag = { kind: 'select'; from: number; x: number } | { kind: 'edge'; edge: 'start' | 'end' } | { kind: 'pan'; x: number; start: number }

/**
 * The waveform: server peaks on a canvas, a ruler you drag to pan, a region you drag out with
 * handles at both ends. Everything the mouse does has a key (see the editor), and the handles are
 * sliders in their own right.
 */
export function WaveformView({ peaks, duration, view, onView, playhead, onSeek, selection, onSelect, trim, cuts, markers, summary }: Props) {
  const uid = useId()
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const { width, height } = useSize(box)
  const [drag, setDrag] = useState<Drag | null>(null)
  const end = view.start + view.span

  const timeAt = (clientX: number) => {
    const r = box.current?.getBoundingClientRect()
    if (!r || !r.width) return view.start
    return clamp(view.start + ((clientX - r.left) / r.width) * view.span, 0, duration)
  }
  const pct = (t: number) => `${((t - view.start) / view.span) * 100}%`

  useEffect(() => {
    const c = canvas.current
    if (!c || !width || !height) return
    const ctx = prepare(c, width, height)
    if (!ctx) return
    const px = (t: number) => ((t - view.start) / view.span) * width
    ctx.fillStyle = token('--color-studio-border', '#d9c9a8')
    ctx.fillRect(0, height / 2, width, 1)
    if (peaks) drawPeaks(ctx, peaks, duration, view.start, view.start + view.span, width, height, token('--color-studio-accent', '#8a5a2b'))
    // what the edit throws away, dimmed under a wash
    ctx.fillStyle = 'rgb(42 28 15 / 0.28)'
    if (trim) {
      ctx.fillRect(0, 0, Math.max(0, px(trim.start)), height)
      ctx.fillRect(px(trim.end), 0, width, height)
    }
    for (const c of cuts) {
      const a = px(c.start)
      const b = px(c.end)
      if (b < 0 || a > width) continue
      ctx.fillRect(a, 0, b - a, height)
      // hatching, so a cut reads as removed and not only as darker
      ctx.save()
      ctx.beginPath()
      ctx.rect(a, 0, b - a, height)
      ctx.clip()
      ctx.strokeStyle = token('--color-studio-danger', '#9b2c2c')
      ctx.lineWidth = 1
      for (let x = a - height; x < b; x += 8) {
        ctx.moveTo(x, height)
        ctx.lineTo(x + height, 0)
      }
      ctx.stroke()
      ctx.restore()
    }
    ctx.fillStyle = token('--color-studio-gold', '#b08d3c')
    for (const m of markers) {
      const x = px(m.t)
      if (x < 0 || x > width) continue
      ctx.fillRect(x, 0, 1, height)
      ctx.fillRect(x - 3, 0, 7, 5)
    }
  }, [peaks, duration, view.start, view.span, width, height, trim, cuts, markers])

  // a non-passive listener, so the page doesn't scroll while the wheel zooms
  const viewRef = useRef({ view, duration, onView })
  useEffect(() => {
    viewRef.current = { view, duration, onView }
  })
  useEffect(() => {
    const el = box.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const { view: v, duration: d, onView: set } = viewRef.current
      if (!d) return
      e.preventDefault()
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const delta = (e.shiftKey ? e.deltaY || e.deltaX : e.deltaX) / 500
        set(clampView({ ...v, start: v.start + delta * v.span }, d))
        return
      }
      const r = el.getBoundingClientRect()
      const at = v.start + ((e.clientX - r.left) / (r.width || 1)) * v.span
      set(zoomView(v, e.deltaY < 0 ? 1.25 : 0.8, at, d))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !duration) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setDrag({ kind: 'select', from: timeAt(e.clientX), x: e.clientX })
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return
    if (drag.kind === 'pan') {
      const w = box.current?.getBoundingClientRect().width || 1
      onView(clampView({ ...view, start: drag.start - ((e.clientX - drag.x) / w) * view.span }, duration))
      return
    }
    const t = timeAt(e.clientX)
    if (drag.kind === 'select') {
      if (Math.abs(e.clientX - drag.x) < 3) return
      onSelect({ start: Math.min(drag.from, t), end: Math.max(drag.from, t) })
    } else if (selection) {
      const other = drag.edge === 'start' ? selection.end : selection.start
      onSelect({ start: Math.min(other, t), end: Math.max(other, t) })
    }
  }
  const onPointerUp = (e: React.PointerEvent) => {
    if (drag?.kind === 'select' && Math.abs(e.clientX - drag.x) < 3) {
      // a click: move the playhead, drop the region
      onSelect(null)
      onSeek(drag.from)
    } else if (drag?.kind !== 'pan' && selection && selection.end - selection.start < MIN_REGION_S) onSelect(null)
    setDrag(null)
  }

  const edgeKey = (edge: 'start' | 'end') => (e: React.KeyboardEvent) => {
    if (!selection) return
    const step = e.shiftKey ? 1 : 0.1
    const by: Record<string, number> = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }
    if (!(e.key in by)) return
    e.preventDefault()
    e.stopPropagation()
    const next = { ...selection }
    if (edge === 'start') next.start = clamp(selection.start + by[e.key], 0, selection.end - MIN_REGION_S)
    else next.end = clamp(selection.end + by[e.key], selection.start + MIN_REGION_S, duration)
    onSelect(next)
  }

  const step = tickStep(view.span, width || 800)
  const ticks: number[] = []
  for (let t = Math.ceil(view.start / step) * step; t <= end + 1e-6; t += step) ticks.push(Number(t.toFixed(3)))

  const handle = (edge: 'start' | 'end', t: number) => (
    <span
      role="slider"
      tabIndex={0}
      aria-label={edge === 'start' ? 'Region start' : 'Region end'}
      aria-valuemin={0}
      aria-valuemax={Math.round(duration * 10) / 10}
      aria-valuenow={Math.round(t * 10) / 10}
      aria-valuetext={stamp(t)}
      onKeyDown={edgeKey(edge)}
      onPointerDown={(e) => {
        e.stopPropagation()
        box.current?.setPointerCapture?.(e.pointerId)
        setDrag({ kind: 'edge', edge })
      }}
      // 16 px of grab area round a 2 px line (Fitts)
      className="absolute inset-y-0 z-10 -ml-2 flex w-4 cursor-ew-resize justify-center focus-visible:outline-2 focus-visible:outline-studio-accent"
      style={{ left: pct(t) }}
    >
      <span aria-hidden className="h-full w-0.5 bg-studio-accent-hover" />
      <span aria-hidden className={cn('absolute top-0 h-3 w-2.5 bg-studio-accent-hover', edge === 'start' ? 'left-2 rounded-r-sm' : 'right-2 rounded-l-sm')} />
    </span>
  )

  return (
    <div className="flex flex-col">
      <div
        aria-hidden
        className="relative h-6 cursor-grab select-none overflow-hidden border-b border-studio-border bg-studio-panel active:cursor-grabbing"
        title="Drag to scroll"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId)
          setDrag({ kind: 'pan', x: e.clientX, start: view.start })
        }}
        onPointerMove={onPointerMove}
        onPointerUp={() => setDrag(null)}
      >
        {ticks.map((t) => (
          <span key={t} className="absolute bottom-0 flex h-full flex-col justify-end border-l border-studio-border-strong pl-1 font-mono text-[10px] leading-3 text-studio-faint" style={{ left: pct(t) }}>
            {stamp(t).replace(/\.0$/, '')}
          </span>
        ))}
      </div>
      <div
        role="group"
        aria-roledescription="waveform"
        aria-label="Waveform"
        aria-describedby={`${uid}-sum`}
        tabIndex={0}
        data-testid="waveform"
        className="relative h-40 touch-none select-none overflow-hidden bg-studio-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-studio-accent md:h-56"
      >
        <div ref={box} className="absolute inset-0 cursor-text" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
          <canvas ref={canvas} aria-hidden className="size-full" />
        </div>
        {selection && selection.end > view.start && selection.start < end && (
          <>
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 bg-studio-accent/15"
              style={{ left: pct(Math.max(selection.start, view.start)), width: `${((Math.min(selection.end, end) - Math.max(selection.start, view.start)) / view.span) * 100}%` }}
            />
            {selection.start >= view.start && handle('start', selection.start)}
            {selection.end <= end && handle('end', selection.end)}
          </>
        )}
        {playhead >= view.start && playhead <= end && (
          <span aria-hidden data-testid="playhead" className="pointer-events-none absolute inset-y-0 w-0.5 bg-studio-text" style={{ left: pct(playhead) }} />
        )}
        <p id={`${uid}-sum`} className="sr-only">
          {summary}
        </p>
      </div>
      <label className="flex items-center gap-2 border-t border-studio-border bg-studio-panel px-2 py-1">
        <span className="sr-only">Scroll the waveform</span>
        <input
          type="range"
          min={0}
          max={Math.max(0, duration - view.span)}
          step={Math.max(0.01, view.span / 50)}
          value={view.start}
          disabled={view.span >= duration}
          aria-valuetext={`Showing ${stamp(view.start)} to ${stamp(end)}`}
          onChange={(e) => onView(clampView({ ...view, start: Number(e.target.value) }, duration))}
          className="h-1 w-full cursor-pointer accent-studio-border-strong disabled:opacity-40"
        />
      </label>
    </div>
  )
}
