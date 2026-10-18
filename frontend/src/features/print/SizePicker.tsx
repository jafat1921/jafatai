import { useId, useState } from 'react'
import { ArrowLeftRight, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Chip } from '@/components/studio/chip'
import { Segmented } from '@/features/image/ads/Segmented'
import { bestDpi, DEFAULT_DISTANCE, DEFAULT_DPI, DISTANCES, DPIS, JOB_LABELS, minCapMm, pixels, PRESETS, sizeLabel, tooBig, type Distance, type PrintJobType, type Shape } from '@/lib/print'

const SELECT = 'h-8 w-full rounded-[6px] border border-studio-border-strong bg-studio-raised px-2 text-body focus-visible:outline-2 focus-visible:outline-studio-accent'
const JOBS = (Object.keys(JOB_LABELS) as PrintJobType[]).map((id) => ({ id, label: JOB_LABELS[id] }))
const UNITS = [
  { id: 'cm', label: 'cm' },
  { id: 'mm', label: 'mm' },
] as const

export interface SizeValue {
  job: PrintJobType
  width_cm: number
  height_cm: number
  dpi: number
  shape: Shape
  viewing_distance: Distance
  unit: 'cm' | 'mm'
}

export const defaultSize = (): SizeValue => ({ job: 'sign', width_cm: 25, height_cm: 70, dpi: 150, shape: 'rect', viewing_distance: 'street', unit: 'cm' })

const shown = (cm: number, unit: 'cm' | 'mm') => String(Math.round((unit === 'mm' ? cm * 10 : cm) * 10) / 10)

/** A number box that keeps what is being typed ("25," on the way to "25,5") and hands on each valid value. */
function NumberField({ id, value, onCommit, disabled }: { id: string; value: string; onCommit: (n: number) => void; disabled?: boolean }) {
  const [text, setText] = useState(value)
  const [last, setLast] = useState(value)
  if (value !== last) {
    setLast(value)
    setText(value)
  }
  return (
    <Input
      id={id}
      inputMode="decimal"
      value={text}
      disabled={disabled}
      onChange={(e) => {
        setText(e.target.value)
        const n = Number(e.target.value.replace(',', '.'))
        if (Number.isFinite(n) && n > 0) onCommit(n)
      }}
    />
  )
}

/** Job type, a size (preset or free, in cm or mm), orientation, dpi and viewing distance, with the pixels it makes. */
export function SizePicker({ value, onChange }: { value: SizeValue; onChange: (v: SizeValue) => void }) {
  const uid = useId()
  const id = (s: string) => `${uid}-${s}`
  const v = value
  const set = (patch: Partial<SizeValue>) => onChange({ ...v, ...patch })
  const px = pixels(v.width_cm, v.height_cm, v.dpi)
  const big = tooBig(v.width_cm, v.height_cm, v.dpi)
  const ratio = v.width_cm / Math.max(v.height_cm, 0.01)
  const preset = PRESETS.find((p) => p.width_cm === v.width_cm && p.height_cm === v.height_cm && (p.shape ?? 'rect') === v.shape)

  const typed = (k: 'width_cm' | 'height_cm', n: number) => {
    const cm = v.unit === 'mm' ? n / 10 : n
    // a round sticker stays round: both sides move together
    set(v.shape === 'round' ? { width_cm: cm, height_cm: cm } : { [k]: cm })
  }

  return (
    <fieldset className="flex min-w-0 flex-col gap-3">
      <legend className="sr-only">Job and size</legend>
      <div className="flex flex-col gap-1">
        <span aria-hidden className="text-small font-medium">
          What are you printing?
        </span>
        <Segmented
          label="What are you printing?"
          options={JOBS}
          value={v.job}
          onChange={(job) => set({ job, dpi: DEFAULT_DPI[job], viewing_distance: DEFAULT_DISTANCE[job], shape: job === 'sticker' ? v.shape : 'rect' })}
          className="w-full"
        />
      </div>

      <div className="flex flex-col gap-1.5" role="group" aria-labelledby={id('pre')}>
        <span id={id('pre')} className="text-small font-medium">
          Size
        </span>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <Chip
              key={p.id}
              selected={preset?.id === p.id}
              onClick={() =>
                set({ job: p.job, width_cm: p.width_cm, height_cm: p.height_cm, shape: p.shape ?? 'rect', dpi: DEFAULT_DPI[p.job], viewing_distance: DEFAULT_DISTANCE[p.job] })
              }
            >
              {p.label}
            </Chip>
          ))}
        </div>
      </div>

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto]">
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={id('w')}>Width ({v.unit})</Label>
          <NumberField id={id('w')} value={shown(v.width_cm, v.unit)} onCommit={(n) => typed('width_cm', n)} />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Swap width and height (turn the sign)"
          disabled={v.shape === 'round'}
          onClick={() => set({ width_cm: v.height_cm, height_cm: v.width_cm })}
        >
          <ArrowLeftRight aria-hidden />
        </Button>
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={id('h')}>Height ({v.unit})</Label>
          <NumberField id={id('h')} value={shown(v.height_cm, v.unit)} disabled={v.shape === 'round'} onCommit={(n) => typed('height_cm', n)} />
        </div>
        <Segmented label="Unit" options={UNITS} value={v.unit} onChange={(unit) => set({ unit })} className="col-span-3 justify-self-start sm:col-span-1" />
      </div>

      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden
          className="flex size-14 shrink-0 items-center justify-center rounded-[6px] border border-studio-border bg-studio-raised"
        >
          <span
            className={v.shape === 'round' ? 'rounded-full bg-studio-accent-soft ring-1 ring-studio-accent' : 'rounded-[2px] bg-studio-accent-soft ring-1 ring-studio-accent'}
            style={ratio >= 1 ? { width: 44, height: Math.max(6, 44 / ratio) } : { height: 44, width: Math.max(6, 44 * ratio) }}
          />
        </span>
        <p className="min-w-0 text-small text-studio-muted" aria-live="polite">
          <span className="block font-medium text-studio-text">{sizeLabel(v.width_cm, v.height_cm, v.dpi)}</span>
          With 3 mm bleed the file is {px.full[0]} × {px.full[1]} px ({px.mp.toFixed(1)} MP).
        </p>
      </div>

      {v.job === 'sticker' && (
        <div className="flex flex-col gap-1">
          <span aria-hidden className="text-small font-medium">
            Sticker shape
          </span>
          <Segmented
            label="Sticker shape"
            options={[
              { id: 'rect', label: 'Rectangle' },
              { id: 'round', label: 'Round' },
            ]}
            value={v.shape}
            onChange={(shape) => set(shape === 'round' ? { shape, height_cm: v.width_cm } : { shape })}
            className="self-start"
          />
        </div>
      )}

      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={id('dpi')}>Resolution</Label>
          <select id={id('dpi')} className={SELECT} value={v.dpi} onChange={(e) => set({ dpi: Number(e.target.value) })} aria-describedby={id('dpi-hint')}>
            {DPIS.map((d) => (
              <option key={d} value={d} disabled={tooBig(v.width_cm, v.height_cm, d)}>
                {d} dpi{tooBig(v.width_cm, v.height_cm, d) ? ' (too large for this size)' : ''}
              </option>
            ))}
          </select>
          <span id={id('dpi-hint')} className="text-small text-studio-muted">
            150 dpi suits signs and boards seen from a distance; 300 dpi suits flyers held in the hand.
          </span>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span aria-hidden className="text-small font-medium">
            Read from
          </span>
          <Segmented label="Read from" options={DISTANCES} value={v.viewing_distance} onChange={(d) => set({ viewing_distance: d })} describedBy={id('dist-hint')} className="w-full" />
          <span id={id('dist-hint')} className="text-small text-studio-muted">
            The smallest letters will be at least {(minCapMm(v.viewing_distance) / 10).toLocaleString('en-GB', { maximumFractionDigits: 2 })} cm tall.
          </span>
        </div>
      </div>

      {big && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-[6px] border border-studio-warning/60 bg-studio-raised p-2 text-small">
          <TriangleAlert aria-hidden className="size-4 shrink-0 text-studio-warning" />
          <span className="min-w-0 flex-1">This size at {v.dpi} dpi is more than one file can hold.</span>
          <Button type="button" size="sm" onClick={() => set({ dpi: bestDpi(v.width_cm, v.height_cm, v.dpi) })}>
            Use {bestDpi(v.width_cm, v.height_cm, v.dpi)} dpi
          </Button>
        </div>
      )}
    </fieldset>
  )
}
