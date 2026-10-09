import type { KeyboardEvent, MouseEvent } from 'react'
import { cn } from '@/lib/utils'

export interface SelectPoints {
  include: { x: number; y: number }[]
  exclude: { x: number; y: number }[]
}

export const MAX_SELECT_POINTS = 24

interface Props {
  points: SelectPoints
  mode: 'include' | 'exclude'
  box: { width: number; height: number }
  onChange: (next: SelectPoints) => void
}

/**
 * Click-to-select for SAM 3 on the shown frame. Positions are kept as 0..1 of the frame; the cut-out
 * tab maps them back through the develop crop. Click a dot (or Delete on it) to remove it.
 */
export function SelectPointsOverlay({ points, mode, box, onChange }: Props) {
  const total = points.include.length + points.exclude.length

  const add = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || total >= MAX_SELECT_POINTS) return
    const r = e.currentTarget.getBoundingClientRect()
    const p = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
    onChange({ ...points, [mode]: [...points[mode], p] })
  }
  const remove = (kind: keyof SelectPoints, i: number) => onChange({ ...points, [kind]: points[kind].filter((_, j) => j !== i) })
  const onKey = (kind: keyof SelectPoints, i: number) => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return
    e.preventDefault()
    remove(kind, i)
  }

  return (
    <div
      className="absolute inset-0 cursor-crosshair"
      onClick={add}
      aria-label={mode === 'include' ? 'Click on what to select' : 'Click on what to leave out'}
    >
      {(['include', 'exclude'] as const).map((kind) =>
        points[kind].map((p, i) => (
          <button
            key={`${kind}-${i}`}
            type="button"
            aria-label={`${kind === 'include' ? 'Select' : 'Leave out'} point ${i + 1}; press Delete to remove`}
            className={cn(
              'absolute -ml-2.5 -mt-2.5 grid size-5 place-items-center rounded-full border-2 border-studio-darkroom text-[11px] font-bold leading-none',
              kind === 'include' ? 'bg-emerald-400 text-emerald-950' : 'bg-rose-400 text-rose-950',
            )}
            style={{ left: p.x * box.width, top: p.y * box.height }}
            onClick={(e) => {
              e.stopPropagation()
              remove(kind, i)
            }}
            onKeyDown={onKey(kind, i)}
          >
            {kind === 'include' ? '+' : '−'}
          </button>
        )),
      )}
    </div>
  )
}
