import type { ReactNode } from 'react'
import { Eye, EyeOff, RotateCcw } from 'lucide-react'
import { Section } from '@/components/studio/section'
import { FALLBACK_GROUPS, FALLBACK_RANGES, changedKeys, getValue, rangeFor } from '@/lib/photo/params'
import type { DevelopParams, HslBand, PhotoSchema, RangeSpec, SchemaGroup, UprightMode } from '@/lib/photo/types'
import { SWITCHABLE, toggleGroup } from '@/lib/photo/workflow'
import { ColourGrading } from './ColourGrading'
import { ColourMixer } from './ColourMixer'
import { BasicHeader, CalibrationPanel, EffectsPanel, SubHead } from './DevelopTools'
import { DevelopSlider } from './DevelopSlider'
import { DetailPanel, LensPanel, TransformPanel } from './OpticsPanels'
import { ToneCurvePanel } from './ToneCurvePanel'

export type Picker = 'wb' | 'pointColor' | 'fringe' | null

const TRACKS: Record<string, string> = {
  temperature: 'linear-gradient(90deg, #4a78b8, #d8cdb6, #d39a3a)',
  tint: 'linear-gradient(90deg, #3f8f5c, #d8cdb6, #b85fb8)',
}

// crop & rotate lives in the tool strip (R), looks in the left panel, as in Lightroom
const IN_TOOLS = new Set(['geometry', 'look'])

interface Props {
  schema: PhotoSchema | undefined
  params: DevelopParams
  // which panels are open; the page owns it for solo mode and Ctrl+1…9
  open: Record<string, boolean>
  onOpen: (id: string, open: boolean) => void
  onSet: (key: string, value: number, group: string | null) => void
  onUpdate: (fn: (p: DevelopParams) => DevelopParams, group: string | null) => void
  // groups that need more than sliders (local light, crop) are drawn by the page
  custom: Partial<Record<string, ReactNode>>
  // the eyedropper on the picture: white balance or a point colour
  picker?: Picker
  onPicker?: (p: Picker) => void
  onAutoWb?: () => void
  // D2b: Detail's mask view, auto CA and Upright are measured by the server
  maskView?: boolean
  onMaskView?: (on: boolean) => void
  onAutoCa?: (on: boolean) => void
  onUpright?: (mode: UprightMode) => void
  measuring?: { ca?: boolean; upright?: boolean; note?: string | null }
}

function groupChanges(g: SchemaGroup, changed: string[]) {
  return changed.filter((k) => g.keys.some((gk) => k === gk || k.startsWith(`${gk}.`))).length
}

function resetGroup(p: DevelopParams, g: SchemaGroup): DevelopParams {
  const next: Record<string, unknown> = { ...p }
  for (const k of g.keys) delete next[k.split('.')[0]]
  return next as DevelopParams
}

/** The edit panels in Lightroom's order, each with an on/off eye, a reset and a change count. */
export function DevelopPanel({ schema, params, open, onOpen, onSet, onUpdate, custom, picker = null, onPicker, onAutoWb, maskView = false, onMaskView, onAutoCa, onUpright, measuring = {} }: Props) {
  const ranges: Record<string, RangeSpec> = schema?.ranges ?? {}
  const groups = schema?.groups ?? FALLBACK_GROUPS
  const spatial = new Set(schema?.spatial_keys ?? ['texture', 'clarity', 'dehaze', 'sharpen', 'nr', 'lightPoints'])
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
    const toggle = (p: Exclude<Picker, null>) => onPicker?.(picker === p ? null : p)
    if (g.id === 'hsl') {
      return (
        <ColourMixer params={params} ranges={ranges} labels={labels} onChange={onSet} onUpdate={onUpdate} picking={picker === 'pointColor'} onPick={onPicker && (() => toggle('pointColor'))} />
      )
    }
    if (g.id === 'curve') return <ToneCurvePanel params={params} ranges={ranges} onSet={onSet} onUpdate={onUpdate} />
    if (g.id === 'grading') return <ColourGrading params={params} ranges={ranges} onSet={onSet} onUpdate={onUpdate} />
    if (g.id === 'effects') return <EffectsPanel params={params} ranges={ranges} onSet={onSet} onUpdate={onUpdate} />
    if (g.id === 'calibration') return <CalibrationPanel params={params} ranges={ranges} onSet={onSet} />
    if (g.id === 'detail') return <DetailPanel params={params} ranges={ranges} onSet={onSet} maskView={maskView} onMaskView={(on) => onMaskView?.(on)} />
    if (g.id === 'lens') {
      return (
        <LensPanel
          params={params} ranges={ranges} onSet={onSet} onUpdate={onUpdate} onAutoCa={onAutoCa} caBusy={measuring.ca}
          picking={picker === 'fringe'} onPick={onPicker && (() => toggle('fringe'))}
        />
      )
    }
    if (g.id === 'transform') {
      return <TransformPanel params={params} ranges={ranges} onSet={onSet} onUpdate={onUpdate} onUpright={onUpright} busy={measuring.upright} note={measuring.note} />
    }
    if (g.id === 'basic') {
      const keys = g.keys.filter((k) => k in ranges || k in FALLBACK_RANGES)
      // Lightroom's Presence block starts at Texture
      const at = keys.indexOf('texture')
      return (
        <div className="flex flex-col gap-2.5">
          <BasicHeader params={params} ranges={ranges} onSet={onSet} onUpdate={onUpdate} picking={picker === 'wb'} onPick={() => toggle('wb')} onAutoWb={() => onAutoWb?.()} />
          {(at < 0 ? keys : keys.slice(0, at)).map(slider)}
          {at >= 0 && <SubHead>Presence</SubHead>}
          {at >= 0 && keys.slice(at).map(slider)}
        </div>
      )
    }
    // anything else made only of numbers gets plain sliders; unknown shapes are skipped
    const keys = g.keys.filter((k) => k in ranges || k in FALLBACK_RANGES)
    if (!keys.length) return null
    return (
      <div className="flex flex-col gap-2.5">
        {keys.map(slider)}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col divide-y divide-studio-border">
        {groups.filter((g) => !IN_TOOLS.has(g.id)).map((g) => {
          const content = body(g)
          if (!content) return null
          const n = groupChanges(g, changed)
          const switchable = (schema?.switchable ?? SWITCHABLE).includes(g.id)
          const isOff = !!params.off?.includes(g.id)
          return (
            <Section
              key={g.id}
              title={g.label}
              count={n || undefined}
              open={!!open[g.id]}
              onOpenChange={(o) => onOpen(g.id, o)}
              dimmed={isOff}
              action={
                <span className="flex items-center">
                {switchable && (n > 0 || isOff) && (
                  <button
                    type="button"
                    aria-pressed={!isOff}
                    aria-label={`${isOff ? 'Turn on' : 'Turn off'} ${g.label}`}
                    title={`${isOff ? 'Turn on' : 'Turn off'} ${g.label} (compare with and without)`}
                    className="rounded-[4px] p-1 text-studio-muted hover:bg-studio-panel-hover hover:text-studio-text"
                    onClick={() => onUpdate((p) => toggleGroup(p, g.id), null)}
                  >
                    {isOff ? <EyeOff aria-hidden className="size-3.5" /> : <Eye aria-hidden className="size-3.5" />}
                  </button>
                )}
                {n > 0 ? (
                  <button
                    type="button"
                    className="rounded-[4px] p-1 text-studio-muted hover:bg-studio-panel-hover hover:text-studio-text"
                    aria-label={`Reset ${g.label}`}
                    title={`Reset ${g.label}`}
                    onClick={() => onUpdate((p) => resetGroup(p, g), null)}
                  >
                    <RotateCcw aria-hidden className="size-3.5" />
                  </button>
                ) : null}
                </span>
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
