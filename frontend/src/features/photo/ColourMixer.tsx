import { useState } from 'react'
import { Pipette, Trash2 } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { hsvToRgb } from '@/lib/photo/maths'
import { getValue, rangeFor } from '@/lib/photo/params'
import { HSL_BANDS, type DevelopParams, type HslBand, type RangeSpec } from '@/lib/photo/types'
import { cn } from '@/lib/utils'
import { DevelopSlider } from './DevelopSlider'

const SWATCH: Record<HslBand, string> = {
  red: '#c0392b',
  orange: '#e67e22',
  yellow: '#e2b80f',
  green: '#3f8f5c',
  aqua: '#1a9c8c',
  blue: '#3d5a80',
  purple: '#7e5bb0',
  magenta: '#b85fb8',
}

const CHANNELS = [
  { id: 'h', label: 'Hue' },
  { id: 's', label: 'Saturation' },
  { id: 'l', label: 'Luminance' },
] as const

type Channel = (typeof CHANNELS)[number]['id'] | 'all'
type PointColour = NonNullable<DevelopParams['pointColor']>[number]
type OnUpdate = (fn: (p: DevelopParams) => DevelopParams, group: string | null) => void

const MAX_POINT_COLOURS = 8

/**
 * Lightroom's Color Mixer: 8 bands × Hue / Saturation / Luminance one channel at a time (Hick's law)
 * or all at once, Point Color picked off the picture, and the B&W mix once the treatment is B&W.
 */
export function ColourMixer({
  params,
  ranges,
  labels,
  onChange,
  onUpdate,
  picking = false,
  onPick,
}: {
  params: DevelopParams
  ranges: Record<string, RangeSpec>
  labels?: Partial<Record<HslBand, string>>
  onChange: (key: string, value: number, group: string) => void
  onUpdate?: OnUpdate
  picking?: boolean
  onPick?: () => void
}) {
  const [mode, setMode] = useState<'mixer' | 'point'>('mixer')
  const [channel, setChannel] = useState<Channel>('s')
  const name = (b: HslBand) => labels?.[b] ?? b.charAt(0).toUpperCase() + b.slice(1)
  const bw = params.treatment === 'bw'

  const band = (b: HslBand, key: string, label: string) => (
    <div key={key} className="flex items-start gap-2">
      <span aria-hidden className="mt-1 size-3 shrink-0 rounded-full border border-studio-border-strong" style={{ background: SWATCH[b] }} />
      <DevelopSlider name={key} label={label} value={getValue(params, key)} range={rangeFor(ranges, key)} onChange={(v, g) => onChange(key, v, g)} className="flex-1" />
    </div>
  )

  const mixer = bw ? (
    <>
      <p className="text-[12px] text-studio-muted">How light or dark each colour turns in black &amp; white.</p>
      {HSL_BANDS.map((b) => band(b, `bw.${b}`, name(b)))}
    </>
  ) : (
    <>
      <ToggleGroup type="single" value={channel} onValueChange={(v) => v && setChannel(v as Channel)} aria-label="Colour mixer channel" className="w-full">
        {CHANNELS.map((c) => (
          <ToggleGroupItem key={c.id} value={c.id} className="px-2 text-small">
            {c.label}
          </ToggleGroupItem>
        ))}
        <ToggleGroupItem value="all" className="px-2 text-small">All</ToggleGroupItem>
      </ToggleGroup>
      {channel === 'all'
        ? CHANNELS.map((c) => (
            <div key={c.id} className="flex flex-col gap-2.5">
              <h4 className="mt-1 text-[11px] font-medium uppercase tracking-wide text-studio-muted">{c.label}</h4>
              {HSL_BANDS.map((b) => band(b, `hsl.${b}.${c.id}`, name(b)))}
            </div>
          ))
        : HSL_BANDS.map((b) => band(b, `hsl.${b}.${channel}`, `${name(b)} ${CHANNELS.find((c) => c.id === channel)!.label.toLowerCase()}`))}
    </>
  )

  return (
    <div className="flex flex-col gap-2.5">
      {onUpdate && (
        <ToggleGroup type="single" value={mode} onValueChange={(v) => v && setMode(v as typeof mode)} aria-label="Colour mixer mode" className="w-full">
          <ToggleGroupItem value="mixer" className="flex-1 px-2 text-small">{bw ? 'B&W mix' : 'Mixer'}</ToggleGroupItem>
          <ToggleGroupItem value="point" className="flex-1 px-2 text-small">Point colour</ToggleGroupItem>
        </ToggleGroup>
      )}
      {mode === 'point' && onUpdate ? <PointColour params={params} ranges={ranges} onUpdate={onUpdate} picking={picking} onPick={onPick} /> : mixer}
    </div>
  )
}

const css = (e: PointColour) => {
  const [r, g, b] = hsvToRgb(e.hue, e.sat, e.val)
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`
}

function PointColour({ params, ranges, onUpdate, picking, onPick }: { params: DevelopParams; ranges: Record<string, RangeSpec>; onUpdate: OnUpdate; picking: boolean; onPick?: () => void }) {
  const list = params.pointColor ?? []
  const [sel, setSel] = useState(0)
  const at = Math.min(sel, list.length - 1)
  const cur = list[at]
  const edit = (k: keyof PointColour, v: number, group: string) =>
    onUpdate((p) => ({ ...p, pointColor: (p.pointColor ?? []).map((e, i) => (i === at ? { ...e, [k]: v } : e)) }), group)

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          aria-pressed={picking}
          disabled={!onPick || list.length >= MAX_POINT_COLOURS}
          onClick={onPick}
          title={list.length >= MAX_POINT_COLOURS ? `Up to ${MAX_POINT_COLOURS} colours` : 'Pick a colour from the picture'}
          className="inline-flex h-7 items-center gap-1.5 rounded-[6px] border border-studio-border-strong px-2 text-small text-studio-muted hover:bg-studio-panel-hover hover:text-studio-text disabled:opacity-50 aria-pressed:border-studio-accent aria-pressed:text-studio-accent"
        >
          <Pipette aria-hidden className="size-3.5" /> Pick
        </button>
        {list.map((e, i) => (
          <button
            key={i}
            type="button"
            aria-label={`Colour ${i + 1}`}
            aria-pressed={i === at}
            onClick={() => setSel(i)}
            className={cn('size-6 rounded-[4px] border-2', i === at ? 'border-studio-accent' : 'border-studio-border-strong')}
            style={{ background: css(e) }}
          />
        ))}
      </div>
      {!cur ? (
        <p className="text-[12px] text-studio-muted">Pick a colour off the picture, then shift its hue, saturation and luminance without touching anything else.</p>
      ) : (
        <>
          {(['dh', 'ds', 'dl'] as const).map((k) => (
            <DevelopSlider key={k} name={`pointColor.${k}`} label={rangeFor(ranges, `pointColor.${k}`).label} value={cur[k] ?? 0} range={rangeFor(ranges, `pointColor.${k}`)} onChange={(v, g) => edit(k, v, g)} />
          ))}
          <details className="text-small">
            <summary className="cursor-pointer text-studio-muted">Range</summary>
            <div className="mt-2 flex flex-col gap-2.5">
              {(['hueRange', 'satRange', 'lumRange'] as const).map((k) => (
                <DevelopSlider key={k} name={`pointColor.${k}`} label={rangeFor(ranges, `pointColor.${k}`).label} value={cur[k] ?? 50} range={rangeFor(ranges, `pointColor.${k}`)} onChange={(v, g) => edit(k, v, g)} />
              ))}
            </div>
          </details>
          <button
            type="button"
            onClick={() => {
              onUpdate((p) => ({ ...p, pointColor: (p.pointColor ?? []).filter((_, i) => i !== at) }), null)
              setSel(Math.max(0, at - 1))
            }}
            className="inline-flex items-center gap-1.5 self-start text-small text-studio-muted hover:text-studio-text"
          >
            <Trash2 aria-hidden className="size-3.5" /> Remove this colour
          </button>
        </>
      )}
    </div>
  )
}
