import { useId, useState, type KeyboardEvent } from 'react'
import type { RangeSpec } from '@/lib/photo/types'
import { cn } from '@/lib/utils'

interface Props {
  name: string
  label: string
  value: number
  range: RangeSpec
  onChange: (value: number, group: string) => void
  // the instant preview can't show it; the server render will
  spatial?: boolean
  // CSS background for the track, e.g. a blue→amber temperature ramp
  track?: string
  className?: string
}

const fmt = (v: number, step: number) => {
  const r = step < 1 ? v.toFixed(1) : String(Math.round(v))
  return v > 0 ? `+${r}` : r
}

/**
 * One develop slider: label, track and an editable number. Arrows nudge by one step (Shift ×10),
 * Home/End jump to the ends, double-click anywhere on the row resets to the default.
 */
export function DevelopSlider({ name, label, value, range, onChange, spatial, track, className }: Props) {
  const id = useId()
  // a half-typed number, remembered with the value it was typed over: Auto or undo moving the
  // value drops it
  const [typed, setTyped] = useState<{ text: string; over: number } | null>(null)
  const draft = typed && typed.over === value ? typed.text : null
  const setDraft = (text: string | null) => setTyped(text == null ? null : { text, over: value })
  const { min, max, step } = range
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step))
  const set = (v: number) => onChange(clamp(v), `slider:${name}`)
  const changed = Math.abs(value - range.default) > step / 2

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const big = e.shiftKey ? 10 : 1
    // + and - are Lightroom's nudge keys for the selected slider
    const map: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 10, PageDown: -10, '+': 1, '=': 1, '-': -1, _: -1 }
    if (e.key in map) {
      e.preventDefault()
      set(value + map[e.key] * step * (e.key.startsWith('Page') ? 1 : big))
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      set(e.key === 'Home' ? min : max)
    }
  }

  const commitDraft = () => {
    if (draft == null) return
    const n = Number(draft.replace(',', '.'))
    setDraft(null)
    if (draft.trim() !== '' && Number.isFinite(n)) onChange(clamp(n), `field:${name}`)
  }

  return (
    <div
      data-develop-slider
      className={cn('grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-0.5', className)}
      onDoubleClick={() => onChange(range.default, `reset:${name}`)}
      title="Double-click to reset"
    >
      <label htmlFor={id} className={cn('truncate text-small', changed ? 'font-medium text-studio-text' : 'text-studio-muted')}>
        {label}
        {spatial && <span className="ml-1 text-[11px] text-studio-muted">· exact on release</span>}
      </label>
      <input
        type="text"
        inputMode="decimal"
        aria-label={`${label} value`}
        value={draft ?? fmt(value, step)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitDraft}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitDraft()
          if (e.key === 'Escape') setDraft(null)
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        className="h-6 w-14 rounded-[4px] border border-studio-border bg-studio-raised px-1 text-right font-mono text-small tabular-nums focus-visible:border-studio-accent"
      />
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={`${label} ${fmt(value, step)}`}
        onChange={(e) => set(Number(e.target.value))}
        onKeyDown={onKeyDown}
        style={track ? { backgroundImage: track } : undefined}
        className={cn(
          'col-span-2 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-studio-border accent-studio-accent',
          '[&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-studio-raised [&::-webkit-slider-thumb]:bg-studio-accent',
          '[&::-moz-range-thumb]:size-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-studio-raised [&::-moz-range-thumb]:bg-studio-accent',
        )}
      />
    </div>
  )
}
