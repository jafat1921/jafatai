import { useState } from 'react'
import { ArrowDownToLine, ArrowUpToLine, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { fieldClass } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { useStageShortcuts } from '@/hooks/useStageShortcuts'
import { outPoint, trimError, trimPatch } from '@/lib/reel'
import type { ReelClip, ReelClipPatch } from '@/lib/types'
import { cn } from '@/lib/utils'

const fmt = (n: number) => String(Math.round(n * 10) / 10)

interface Props {
  clip: ReelClip
  playhead: () => number | null
  onSave: (patch: ReelClipPatch) => void
}

/** In/out points as numbers, plus "set at playhead". Saves only a valid pair. */
export function TrimControls({ clip, playhead, onSave }: Props) {
  const source = clip.source_duration_s
  const [inText, setIn] = useState(fmt(clip.trim_in_s))
  const [outText, setOut] = useState(fmt(outPoint(clip)))
  const [seen, setSeen] = useState(`${clip.trim_in_s}:${clip.trim_out_s}`)
  const key = `${clip.trim_in_s}:${clip.trim_out_s}`
  if (key !== seen) {
    setSeen(key)
    setIn(fmt(clip.trim_in_s))
    setOut(fmt(outPoint(clip)))
  }

  const inS = Number(inText)
  const outS = Number(outText)
  const error = inText.trim() === '' || outText.trim() === '' ? 'Enter both points.' : trimError(inS, outS, source)

  const commit = (nextIn = inS, nextOut = outS) => {
    if (trimError(nextIn, nextOut, source)) return
    const patch = trimPatch(nextIn, nextOut, source)
    if (patch.trim_in_s !== clip.trim_in_s || patch.trim_out_s !== clip.trim_out_s) onSave(patch)
  }

  const atPlayhead = (side: 'in' | 'out') => {
    const t = playhead()
    if (t === null) return
    if (side === 'in') {
      setIn(fmt(t))
      commit(t, outS)
    } else {
      setOut(fmt(t))
      commit(inS, t)
    }
  }

  useStageShortcuts({ i: () => atPlayhead('in'), o: () => atPlayhead('out') })

  const field = (id: string, label: string, value: string, set: (v: string) => void) => (
    <div className="flex flex-col gap-0.5">
      <label htmlFor={id} className="text-small text-studio-muted">
        {label}
      </label>
      <input
        id={id}
        type="number"
        step={0.1}
        min={0}
        max={source}
        value={value}
        aria-invalid={!!error || undefined}
        aria-describedby={error ? 'trim-error' : undefined}
        onChange={(e) => set(e.target.value)}
        onBlur={() => commit()}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        className={cn(fieldClass, 'h-7 w-24 font-mono text-small')}
      />
    </div>
  )

  return (
    <div role="group" aria-labelledby="trim-h" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span id="trim-h" className="section-label">
          Trim
        </span>
        <span className="font-mono text-small text-studio-muted">
          {error ? '—' : fmt(outS - inS)} s of {fmt(source)} s
        </span>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        {field('trim-in', 'In (s)', inText, setIn)}
        {field('trim-out', 'Out (s)', outText, setOut)}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setIn('0')
            setOut(fmt(source))
            commit(0, source)
          }}
        >
          <RotateCcw aria-hidden />
          Reset
        </Button>
      </div>
      {error && (
        <p id="trim-error" role="alert" className="text-small text-studio-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="secondary" onClick={() => atPlayhead('in')} aria-keyshortcuts="I">
          <ArrowDownToLine aria-hidden className="-rotate-90" />
          Set in at playhead
          <Kbd>I</Kbd>
        </Button>
        <Button size="sm" variant="secondary" onClick={() => atPlayhead('out')} aria-keyshortcuts="O">
          <ArrowUpToLine aria-hidden className="rotate-90" />
          Set out at playhead
          <Kbd>O</Kbd>
        </Button>
      </div>
    </div>
  )
}
