import { useState } from 'react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { DevelopParams, RangeSpec } from '@/lib/photo/types'
import { ParamSlider } from './DevelopTools'
import { PointCurve, type Pt } from './PointCurve'
import { ToneCurve } from './ToneCurve'

type Mode = 'parametric' | 'rgb' | 'red' | 'green' | 'blue'
type OnSet = (key: string, value: number, group: string | null) => void
type OnUpdate = (fn: (p: DevelopParams) => DevelopParams, group: string | null) => void

const MODES: { id: Mode; label: string; title: string }[] = [
  { id: 'parametric', label: 'Region', title: 'Parametric (region) curve' },
  { id: 'rgb', label: 'RGB', title: 'Point curve' },
  { id: 'red', label: 'R', title: 'Red channel' },
  { id: 'green', label: 'G', title: 'Green channel' },
  { id: 'blue', label: 'B', title: 'Blue channel' },
]

const PRESETS: Record<string, Pt[]> = {
  linear: [[0, 0], [255, 255]],
  medium: [[0, 0], [64, 56], [128, 128], [192, 202], [255, 255]],
  strong: [[0, 0], [64, 46], [128, 128], [192, 212], [255, 255]],
}

export function ToneCurvePanel({ params, ranges, onSet, onUpdate }: { params: DevelopParams; ranges: Record<string, RangeSpec>; onSet: OnSet; onUpdate: OnUpdate }) {
  const [mode, setMode] = useState<Mode>('parametric')
  const s = (k: string, label?: string) => <ParamSlider key={k} k={k} params={params} ranges={ranges} onSet={onSet} label={label} />
  const setPoints = (ch: Exclude<Mode, 'parametric'>) => (pts: Pt[], group: string) =>
    onUpdate((p) => ({ ...p, points: { ...p.points, [ch]: pts } }), group)
  const preset = Object.entries(PRESETS).find(([, v]) => JSON.stringify(v) === JSON.stringify(params.points?.rgb ?? PRESETS.linear))?.[0] ?? 'custom'

  return (
    <div className="flex flex-col gap-2.5">
      <ToggleGroup type="single" value={mode} onValueChange={(v) => v && setMode(v as Mode)} aria-label="Curve" className="w-full">
        {MODES.map((m) => (
          <ToggleGroupItem key={m.id} value={m.id} title={m.title} className="px-2 text-small">
            {m.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {mode === 'parametric' ? (
        <>
          <ToneCurve params={params} onChange={(k, v, grp) => onSet(`curve.${k}`, v, grp)} />
          {s('pcurve.highlights')}
          {s('pcurve.lights')}
          {s('pcurve.darks')}
          {s('pcurve.shadows')}
          <details className="text-small">
            <summary className="cursor-pointer text-studio-muted">Region splits</summary>
            <div className="mt-2 flex flex-col gap-2.5">
              {s('pcurve.s1', 'Shadows | darks')}
              {s('pcurve.s2', 'Darks | lights')}
              {s('pcurve.s3', 'Lights | highlights')}
            </div>
          </details>
        </>
      ) : (
        <>
          <PointCurve key={mode} channel={mode} points={params.points?.[mode]} onChange={setPoints(mode)} />
          <p className="text-[12px] text-studio-muted">Click to add a point · drag to move · double-click or Delete removes</p>
          {mode === 'rgb' && (
            <label className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-small text-studio-muted">Preset</span>
              <select
                className="h-7 min-w-0 flex-1 rounded-[6px] border border-studio-border-strong bg-studio-raised px-2 text-small text-studio-text"
                value={preset}
                onChange={(e) => {
                  const v = PRESETS[e.target.value]
                  if (v) setPoints('rgb')(v, 'points:preset')
                }}
              >
                <option value="linear">Linear</option>
                <option value="medium">Medium contrast</option>
                <option value="strong">Strong contrast</option>
                {preset === 'custom' && <option value="custom">Custom</option>}
              </select>
            </label>
          )}
        </>
      )}
      {s('refineSat')}
    </div>
  )
}
