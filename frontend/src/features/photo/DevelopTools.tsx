import { Pipette, Wand2 } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { usePhotoProfiles } from '@/hooks/usePhoto'
import { getValue, rangeFor } from '@/lib/photo/params'
import type { DevelopParams, RangeSpec } from '@/lib/photo/types'
import { cn } from '@/lib/utils'
import { DevelopSlider } from './DevelopSlider'

type OnSet = (key: string, value: number, group: string | null) => void
type OnUpdate = (fn: (p: DevelopParams) => DevelopParams, group: string | null) => void

export const SELECT = 'h-7 min-w-0 flex-1 rounded-[6px] border border-studio-border-strong bg-studio-raised px-2 text-small text-studio-text'
const ICON_BTN =
  'inline-flex size-7 shrink-0 items-center justify-center rounded-[6px] border border-studio-border-strong text-studio-muted hover:bg-studio-panel-hover hover:text-studio-text aria-pressed:border-studio-accent aria-pressed:text-studio-accent'

export function ParamSlider({ k, params, ranges, onSet, label, track, spatial }: {
  k: string
  params: DevelopParams
  ranges: Record<string, RangeSpec>
  onSet: OnSet
  label?: string
  track?: string
  spatial?: boolean
}) {
  const r = rangeFor(ranges, k)
  return (
    <DevelopSlider
      name={k}
      label={label ?? r.label}
      value={getValue(params, k)}
      range={r}
      spatial={spatial ?? r.spatial}
      track={track}
      onChange={(v, g) => onSet(k, v, g)}
    />
  )
}

export function SubHead({ children }: { children: string }) {
  return <h4 className="mt-1 text-[11px] font-medium uppercase tracking-wide text-studio-muted">{children}</h4>
}

// ---------------------------------------------------------------- Basic: treatment, profile, white balance

export function BasicHeader({ params, ranges, onSet, onUpdate, picking, onPick, onAutoWb }: {
  params: DevelopParams
  ranges: Record<string, RangeSpec>
  onSet: OnSet
  onUpdate: OnUpdate
  picking: boolean
  onPick: () => void
  onAutoWb: () => void
}) {
  const profiles = usePhotoProfiles().data ?? []
  const groups = [...new Set(profiles.map((p) => p.group))]
  const current = params.profile?.id ?? 'color'
  const bw = params.treatment === 'bw'
  const wbCustom = !!(params.temperature || params.tint)

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-small text-studio-muted">Treatment</span>
        <ToggleGroup
          type="single"
          value={bw ? 'bw' : 'color'}
          onValueChange={(v) => v && onUpdate((p) => ({ ...p, treatment: v as 'color' | 'bw' }), null)}
          aria-label="Treatment"
          className="flex-1"
        >
          <ToggleGroupItem value="color" className="flex-1 px-2 text-small">Colour</ToggleGroupItem>
          <ToggleGroupItem value="bw" className="flex-1 px-2 text-small" title="Black & white (V)">B&amp;W</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <label className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-small text-studio-muted">Profile</span>
        <select
          className={SELECT}
          value={current}
          onChange={(e) => {
            const id = e.target.value
            onUpdate((p) => ({ ...p, profile: id === 'color' ? null : { id, amount: p.profile?.amount ?? 100 } }), null)
          }}
        >
          {!profiles.length && <option value="color">Colour</option>}
          {groups.map((g) => (
            <optgroup key={g} label={g}>
              {profiles.filter((p) => p.group === g).map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {params.profile && <ParamSlider k="profile.amount" params={params} ranges={ranges} onSet={onSet} label="Profile amount" />}
      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-small text-studio-muted">WB</span>
        <select
          className={SELECT}
          aria-label="White balance"
          value={wbCustom ? 'custom' : 'shot'}
          onChange={(e) => {
            if (e.target.value === 'auto') onAutoWb()
            else if (e.target.value === 'shot') onUpdate((p) => ({ ...p, temperature: 0, tint: 0 }), null)
          }}
        >
          <option value="shot">As shot</option>
          <option value="auto">Auto</option>
          {wbCustom && <option value="custom">Custom</option>}
        </select>
        <button type="button" aria-pressed={picking} onClick={onPick} className={ICON_BTN} title="White balance selector (W): click something that should be neutral grey">
          <Pipette aria-hidden className="size-3.5" />
          <span className="sr-only">White balance selector</span>
        </button>
        <button type="button" onClick={onAutoWb} className={ICON_BTN} title="Auto white balance">
          <Wand2 aria-hidden className="size-3.5" />
          <span className="sr-only">Auto white balance</span>
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- Effects: post-crop vignette and grain

const STYLES = [
  { id: 'highlight', label: 'Highlight priority' },
  { id: 'color', label: 'Colour priority' },
  { id: 'paint', label: 'Paint overlay' },
] as const

export function EffectsPanel({ params, ranges, onSet, onUpdate }: { params: DevelopParams; ranges: Record<string, RangeSpec>; onSet: OnSet; onUpdate: OnUpdate }) {
  const s = (k: string) => <ParamSlider key={k} k={k} params={params} ranges={ranges} onSet={onSet} />
  const vig = !!params.vignette
  const grain = !!params.grainAmount
  return (
    <div className="flex flex-col gap-2.5">
      <SubHead>Post-crop vignetting</SubHead>
      {s('vignette')}
      <label className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-small text-studio-muted">Style</span>
        <select
          className={SELECT}
          value={params.vignetteStyle ?? 'highlight'}
          onChange={(e) => onUpdate((p) => ({ ...p, vignetteStyle: e.target.value as NonNullable<DevelopParams['vignetteStyle']> }), null)}
        >
          {STYLES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
        </select>
      </label>
      {/* Lightroom greys these out until there's a vignette; same here, but they stay reachable */}
      <div className={cn('flex flex-col gap-2.5', !vig && 'opacity-60')}>
        {['vignetteMidpoint', 'vignetteRoundness', 'vignetteFeather'].map(s)}
        {(params.vignetteStyle ?? 'highlight') === 'highlight' && s('vignetteHighlights')}
      </div>
      <SubHead>Grain</SubHead>
      {s('grainAmount')}
      <div className={cn('flex flex-col gap-2.5', !grain && 'opacity-60')}>{['grainSize', 'grainRoughness'].map(s)}</div>
    </div>
  )
}

// ---------------------------------------------------------------- Calibration

const PRIMARY_TRACKS: Record<string, string> = {
  'calibration.shadowsTint': 'linear-gradient(90deg, #3f8f5c, #d8cdb6, #b85fb8)',
  'calibration.redHue': 'linear-gradient(90deg, #c0306a, #c0392b, #e67e22)',
  'calibration.redSat': 'linear-gradient(90deg, #9a8f86, #d0322a)',
  'calibration.greenHue': 'linear-gradient(90deg, #b0b020, #3f8f5c, #1a9c8c)',
  'calibration.greenSat': 'linear-gradient(90deg, #8e968f, #2e9a4c)',
  'calibration.blueHue': 'linear-gradient(90deg, #1a9c8c, #3d5a80, #7e5bb0)',
  'calibration.blueSat': 'linear-gradient(90deg, #8a8d96, #2f56b0)',
}

export function CalibrationPanel({ params, ranges, onSet }: { params: DevelopParams; ranges: Record<string, RangeSpec>; onSet: OnSet }) {
  const s = (k: string) => <ParamSlider key={k} k={k} params={params} ranges={ranges} onSet={onSet} track={PRIMARY_TRACKS[k]} />
  return (
    <div className="flex flex-col gap-2.5">
      {s('calibration.shadowsTint')}
      <SubHead>Red primary</SubHead>
      {['calibration.redHue', 'calibration.redSat'].map(s)}
      <SubHead>Green primary</SubHead>
      {['calibration.greenHue', 'calibration.greenSat'].map(s)}
      <SubHead>Blue primary</SubHead>
      {['calibration.blueHue', 'calibration.blueSat'].map(s)}
    </div>
  )
}
