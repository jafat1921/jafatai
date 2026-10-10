import { useRef, useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { stamp, type DubSegment } from '@/lib/dub'
import { cn } from '@/lib/utils'

const ZOOMS = [1, 2, 4, 8, 16]

interface Props {
  segments: DubSegment[]
  duration: number
  time: number
  lang: string
  focused: number
  colorOf: (speakerId: string | null) => string
  onSeek: (t: number) => void
  onFocus: (i: number) => void
}

/** Every line as a block on the film's length; click empty space to seek, a block to jump to its line. */
export function Timeline({ segments, duration, time, lang, focused, colorOf, onSeek, onFocus }: Props) {
  const [zoom, setZoom] = useState(1)
  const track = useRef<HTMLDivElement>(null)
  const total = Math.max(duration, segments.at(-1)?.end ?? 0, 0.1)
  const pct = (t: number) => `${(t / total) * 100}%`
  const step = (dir: 1 | -1) => setZoom((z) => ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z) + dir))])

  const seekAt = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = track.current?.getBoundingClientRect()
    if (!r || r.width <= 0) return
    onSeek(((e.clientX - r.left) / r.width) * total)
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1 text-[11px] text-studio-muted">
        <span className="section-label">Timeline</span>
        <span className="ml-auto font-mono">
          {stamp(time)} / {stamp(total)}
        </span>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Zoom out" disabled={zoom === ZOOMS[0]} onClick={() => step(-1)}>
          <Minus aria-hidden />
        </Button>
        <span className="w-8 text-center font-mono" aria-live="polite">
          {zoom}×
        </span>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Zoom in" disabled={zoom === ZOOMS.at(-1)} onClick={() => step(1)}>
          <Plus aria-hidden />
        </Button>
      </div>
      <div className="overflow-x-auto rounded-[6px] border border-studio-border bg-studio-raised" onWheel={(e) => e.ctrlKey && step(e.deltaY < 0 ? 1 : -1)}>
        <div ref={track} role="group" aria-label="Segments on the timeline" className="relative h-12" style={{ width: `${zoom * 100}%` }} onClick={seekAt}>
          {segments.map((s, i) => {
            const t = s.target?.[lang]
            const warn = !!t?.verify?.flags?.length || t?.status === 'failed'
            return (
              <button
                key={s.id}
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onFocus(i)
                  onSeek(s.start)
                }}
                aria-label={`Line ${i + 1} at ${stamp(s.start)}${warn ? ', flagged' : ''}`}
                aria-current={i === focused || undefined}
                className={cn(
                  'absolute top-2 h-8 min-w-[3px] rounded-[3px] border border-black/10 opacity-85 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-studio-accent',
                  i === focused && 'ring-2 ring-studio-accent',
                  warn && 'border-b-4 border-b-studio-warning',
                )}
                style={{ left: pct(s.start), width: pct(Math.max(0.05, s.end - s.start)), background: colorOf(s.speaker_id) }}
              />
            )
          })}
          <span aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-studio-danger" style={{ left: pct(Math.min(time, total)) }} />
        </div>
      </div>
    </div>
  )
}
