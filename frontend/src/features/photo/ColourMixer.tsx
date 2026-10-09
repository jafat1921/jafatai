import { useState } from 'react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { getValue, rangeFor } from '@/lib/photo/params'
import { HSL_BANDS, type DevelopParams, type HslBand, type RangeSpec } from '@/lib/photo/types'
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

type Channel = (typeof CHANNELS)[number]['id']

/** 8 colour bands × Hue / Saturation / Luminance, one channel at a time (Hick's law). */
export function ColourMixer({
  params,
  ranges,
  labels,
  onChange,
}: {
  params: DevelopParams
  ranges: Record<string, RangeSpec>
  labels?: Partial<Record<HslBand, string>>
  onChange: (key: string, value: number, group: string) => void
}) {
  const [channel, setChannel] = useState<Channel>('s')
  const name = (b: HslBand) => labels?.[b] ?? b.charAt(0).toUpperCase() + b.slice(1)

  return (
    <div className="flex flex-col gap-2.5">
      <ToggleGroup type="single" value={channel} onValueChange={(v) => v && setChannel(v as Channel)} aria-label="Colour mixer channel" className="w-full">
        {CHANNELS.map((c) => (
          <ToggleGroupItem key={c.id} value={c.id} className="px-2 text-small">
            {c.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {HSL_BANDS.map((b) => {
        const key = `hsl.${b}.${channel}`
        return (
          <div key={key} className="flex items-start gap-2">
            <span aria-hidden className="mt-1 size-3 shrink-0 rounded-full border border-studio-border-strong" style={{ background: SWATCH[b] }} />
            <DevelopSlider
              name={key}
              label={`${name(b)} ${CHANNELS.find((c) => c.id === channel)!.label.toLowerCase()}`}
              value={getValue(params, key)}
              range={rangeFor(ranges, key)}
              onChange={(v, g) => onChange(key, v, g)}
              className="flex-1"
            />
          </div>
        )
      })}
    </div>
  )
}
