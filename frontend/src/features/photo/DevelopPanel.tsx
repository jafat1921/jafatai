import type { ReactNode } from 'react'
import { RotateCcw } from 'lucide-react'
import { Section } from '@/components/studio/section'
import { FALLBACK_GROUPS, FALLBACK_RANGES, changedKeys, getValue, rangeFor } from '@/lib/photo/params'
import type { DevelopParams, Histogram, HslBand, PhotoSchema, RangeSpec, SchemaGroup } from '@/lib/photo/types'
import { ColourMixer } from './ColourMixer'
import { DevelopSlider } from './DevelopSlider'
import { HistogramView } from './HistogramView'
import { ToneCurve } from './ToneCurve'

const TRACKS: Record<string, string> = {
  temperature: 'linear-gradient(90deg, #4a78b8, #d8cdb6, #d39a3a)',
  tint: 'linear-gradient(90deg, #3f8f5c, #d8cdb6, #b85fb8)',
}

// the server-only groups say so up front instead of on every slider
const NOTES: Record<string, string> = {
  detail: 'Detail is worked out on the server: the preview sharpens up a moment after you let go.',
}

const OPEN_BY_DEFAULT = new Set(['basic'])

interface Props {
  schema: PhotoSchema | undefined
  params: DevelopParams
  histogram: Histogram | null
  live: boolean
  onSet: (key: string, value: number, group: string | null) => void
  onUpdate: (fn: (p: DevelopParams) => DevelopParams, group: string | null) => void
  // groups that need more than sliders (local light, crop) are drawn by the page
  custom: Partial<Record<string, ReactNode>>
}

function groupChanges(g: SchemaGroup, changed: string[]) {
  return changed.filter((k) => g.keys.some((gk) => k === gk || k.startsWith(`${gk}.`))).length
}

function resetGroup(p: DevelopParams, g: SchemaGroup): DevelopParams {
  const next: Record<string, unknown> = { ...p }
  for (const k of g.keys) delete next[k.split('.')[0]]
  return next as DevelopParams
}

/** Histogram on top, then one collapsible section per schema group. */
export function DevelopPanel({ schema, params, histogram, live, onSet, onUpdate, custom }: Props) {
  const ranges: Record<string, RangeSpec> = schema?.ranges ?? {}
  const groups = schema?.groups ?? FALLBACK_GROUPS
  const spatial = new Set(schema?.spatial_keys ?? ['clarity', 'sharpness', 'noiseReduction', 'lightPoints'])
  const changed = changedKeys(params)
  const labels = Object.fromEntries((schema?.hsl_bands ?? []).map((b) => [b.id, b.label])) as Partial<Record<HslBand, string>>

  const slider = (key: string) => {
    const r = rangeFor(ranges, key)
    return (
      <DevelopSlider
        key={key}
        name={key}
        label={r.label}
        value={getValue(params, key)}
        range={r}
        spatial={r.spatial ?? spatial.has(key)}
        track={TRACKS[key]}
        onChange={(v, g) => onSet(key, v, g)}
      />
    )
  }

  const body = (g: SchemaGroup): ReactNode => {
    if (custom[g.id]) return custom[g.id]
    if (g.id === 'hsl') return <ColourMixer params={params} ranges={ranges} labels={labels} onChange={onSet} />
    if (g.id === 'curve') {
      return (
        <div className="flex flex-col gap-2.5">
          <ToneCurve params={params} onChange={(k, v, grp) => onSet(`curve.${k}`, v, grp)} />
          {g.keys.map(slider)}
        </div>
      )
    }
    // anything else made only of numbers gets plain sliders; unknown shapes are skipped
    const keys = g.keys.filter((k) => k in ranges || k in FALLBACK_RANGES)
    if (!keys.length) return null
    return (
      <div className="flex flex-col gap-2.5">
        {NOTES[g.id] && <p className="text-[12px] text-studio-muted">{NOTES[g.id]}</p>}
        {keys.map(slider)}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <HistogramView data={histogram} live={live} />
      <div className="flex flex-col divide-y divide-studio-border">
        {groups.map((g) => {
          const content = body(g)
          if (!content) return null
          const n = groupChanges(g, changed)
          return (
            <Section
              key={g.id}
              title={g.label}
              count={n || undefined}
              defaultOpen={OPEN_BY_DEFAULT.has(g.id)}
              action={
                n > 0 ? (
                  <button
                    type="button"
                    className="rounded-[4px] p-1 text-studio-muted hover:bg-studio-panel-hover hover:text-studio-text"
                    aria-label={`Reset ${g.label}`}
                    title={`Reset ${g.label}`}
                    onClick={() => onUpdate((p) => resetGroup(p, g), null)}
                  >
                    <RotateCcw aria-hidden className="size-3.5" />
                  </button>
                ) : undefined
              }
            >
              <div className="px-1 pb-2">{content}</div>
            </Section>
          )
        })}
      </div>
    </div>
  )
}
