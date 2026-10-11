import { useState } from 'react'
import { Eye, Loader2, Pipette } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { DevelopParams, RangeSpec, UprightMode } from '@/lib/photo/types'
import { cn } from '@/lib/utils'
import { ParamSlider, SubHead } from './DevelopTools'

type OnSet = (key: string, value: number, group: string | null) => void
type OnUpdate = (fn: (p: DevelopParams) => DevelopParams, group: string | null) => void

const TOGGLE =
  'inline-flex h-7 items-center gap-1.5 rounded-[6px] border border-studio-border-strong px-2 text-small text-studio-muted hover:bg-studio-panel-hover hover:text-studio-text aria-pressed:border-studio-accent aria-pressed:text-studio-accent'

function Check({ checked, onChange, children, hint }: { checked: boolean; onChange: (on: boolean) => void; children: string; hint?: string }) {
  return (
    <label className="flex items-center gap-2 text-small text-studio-text" title={hint}>
      <input type="checkbox" className="size-4 accent-studio-accent" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  )
}

const ServerNote = ({ children }: { children: string }) => <p className="text-[12px] text-studio-muted">{children}</p>

// ---------------------------------------------------------------- Detail

export function DetailPanel({ params, ranges, onSet, maskView, onMaskView }: {
  params: DevelopParams
  ranges: Record<string, RangeSpec>
  onSet: OnSet
  maskView: boolean
  onMaskView: (on: boolean) => void
}) {
  // two "Detail" and two "Contrast"-like sliders would read the same to a screen reader
  const NAMES: Record<string, string> = { 'nr.detail': 'Luminance detail', 'nr.contrast': 'Luminance contrast' }
  const s = (k: string) => <ParamSlider key={k} k={k} params={params} ranges={ranges} onSet={onSet} label={NAMES[k]} />
  return (
    <div className="flex flex-col gap-2.5">
      <ServerNote>Detail is worked out on the server: the preview sharpens up a moment after you let go.</ServerNote>
      <div className="flex items-center justify-between">
        <SubHead>Sharpening</SubHead>
        <button
          type="button"
          aria-pressed={maskView}
          className={TOGGLE}
          title="Show what Masking leaves sharpened (white) — Lightroom's Alt-drag view"
          onClick={() => onMaskView(!maskView)}
        >
          <Eye aria-hidden className="size-3.5" />
          Show mask
        </button>
      </div>
      {['sharpen.amount', 'sharpen.radius', 'sharpen.detail', 'sharpen.masking'].map(s)}
      <SubHead>Noise reduction</SubHead>
      {s('nr.luminance')}
      <div className={cn('flex flex-col gap-2.5', !params.nr?.luminance && 'opacity-60')}>{['nr.detail', 'nr.contrast'].map(s)}</div>
      {s('nr.color')}
      <div className={cn('flex flex-col gap-2.5', !params.nr?.color && 'opacity-60')}>{['nr.colorDetail', 'nr.smoothness'].map(s)}</div>
    </div>
  )
}

// ---------------------------------------------------------------- Lens corrections

const CA_TRACK: Record<string, string> = {
  'lens.caRed': 'linear-gradient(90deg, #2aa6a6, #d8cdb6, #c0392b)',
  'lens.caBlue': 'linear-gradient(90deg, #d4b21f, #d8cdb6, #2f56b0)',
  'lens.purpleHueLo': 'linear-gradient(90deg, #5a4fcf, #9b4fcf, #cf4fb0)',
  'lens.purpleHueHi': 'linear-gradient(90deg, #5a4fcf, #9b4fcf, #cf4fb0)',
  'lens.greenHueLo': 'linear-gradient(90deg, #b0b020, #3f8f5c, #1a9c8c)',
  'lens.greenHueHi': 'linear-gradient(90deg, #b0b020, #3f8f5c, #1a9c8c)',
}

export function LensPanel({ params, ranges, onSet, onUpdate, onAutoCa, caBusy, picking, onPick }: {
  params: DevelopParams
  ranges: Record<string, RangeSpec>
  onSet: OnSet
  onUpdate: OnUpdate
  onAutoCa?: (on: boolean) => void
  caBusy?: boolean
  picking?: boolean
  onPick?: () => void
}) {
  const [tab, setTab] = useState<'profile' | 'manual'>('profile')
  const lens = params.lens ?? {}
  const s = (k: string, label?: string) => <ParamSlider key={k} k={k} params={params} ranges={ranges} onSet={onSet} label={label} track={CA_TRACK[k]} />
  return (
    <div className="flex flex-col gap-2.5">
      <ToggleGroup type="single" value={tab} onValueChange={(v) => v && setTab(v as 'profile' | 'manual')} aria-label="Lens corrections view">
        <ToggleGroupItem value="profile" className="flex-1 px-2 text-small">Profile</ToggleGroupItem>
        <ToggleGroupItem value="manual" className="flex-1 px-2 text-small">Manual</ToggleGroupItem>
      </ToggleGroup>
      {tab === 'profile' ? (
        <>
          <div className="flex items-center gap-2">
            <Check
              checked={!!lens.caAuto}
              onChange={(on) => (onAutoCa ? onAutoCa(on) : onUpdate((p) => ({ ...p, lens: { ...p.lens, caAuto: on } }), null))}
              hint="Finds and lines up the red and blue fringes along edges"
            >
              Remove chromatic aberration
            </Check>
            {caBusy && <Loader2 aria-label="Measuring" className="size-3.5 text-studio-muted motion-safe:animate-spin" />}
          </div>
          <SubHead>Lateral CA (fine-tune)</SubHead>
          {s('lens.caRed')}
          {s('lens.caBlue')}
          <ServerNote>We have no camera lens profiles; these correct what a profile would, measured on this picture.</ServerNote>
        </>
      ) : (
        <>
          {s('lens.distortion')}
          <Check
            checked={!!params.transform?.constrain}
            onChange={(on) => onUpdate((p) => ({ ...p, transform: { ...p.transform, constrain: on } }), null)}
            hint="Zoom in just enough that no blank edges show"
          >
            Constrain crop
          </Check>
          <div className="flex items-center justify-between">
            <SubHead>Defringe</SubHead>
            {onPick && (
              <button type="button" aria-pressed={!!picking} onClick={onPick} className={TOGGLE} title="Fringe colour selector: click a purple or green fringe">
                <Pipette aria-hidden className="size-3.5" />
                <span className="sr-only">Fringe colour selector</span>
              </button>
            )}
          </div>
          {s('lens.purpleAmount')}
          <div className={cn('flex flex-col gap-2.5', !lens.purpleAmount && 'opacity-60')}>
            {s('lens.purpleHueLo', 'Purple hue from')}
            {s('lens.purpleHueHi', 'Purple hue to')}
          </div>
          {s('lens.greenAmount')}
          <div className={cn('flex flex-col gap-2.5', !lens.greenAmount && 'opacity-60')}>
            {s('lens.greenHueLo', 'Green hue from')}
            {s('lens.greenHueHi', 'Green hue to')}
          </div>
          <SubHead>Lens vignetting</SubHead>
          {s('lens.vignette', 'Vignetting amount')}
          <div className={cn(!lens.vignette && 'opacity-60')}>{s('lens.vignetteMidpoint')}</div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- Transform

const UPRIGHT: { id: UprightMode; label: string; hint: string }[] = [
  { id: 'off', label: 'Off', hint: 'No automatic correction' },
  { id: 'auto', label: 'Auto', hint: 'Balanced: level, and verticals when they only lean a little' },
  { id: 'level', label: 'Level', hint: 'Level the horizon' },
  { id: 'vertical', label: 'Vertical', hint: 'Level, and make vertical lines parallel' },
  { id: 'full', label: 'Full', hint: 'Vertical and horizontal perspective' },
]

export function TransformPanel({ params, ranges, onSet, onUpdate, onUpright, busy, note }: {
  params: DevelopParams
  ranges: Record<string, RangeSpec>
  onSet: OnSet
  onUpdate: OnUpdate
  onUpright?: (mode: UprightMode) => void
  busy?: boolean
  note?: string | null
}) {
  const t = params.transform ?? {}
  const mode = t.upright ?? 'off'
  const s = (k: string) => <ParamSlider key={k} k={k} params={params} ranges={ranges} onSet={onSet} />
  return (
    <div className="flex flex-col gap-2.5">
      <SubHead>Upright</SubHead>
      <ToggleGroup
        type="single"
        value={mode}
        onValueChange={(v) => {
          if (!v) return
          if (onUpright) onUpright(v as UprightMode)
          else onUpdate((p) => ({ ...p, transform: { ...p.transform, upright: v as UprightMode, uprightMatrix: null } }), null)
        }}
        aria-label="Upright"
        className="grid grid-cols-5"
      >
        {UPRIGHT.map((u) => (
          <ToggleGroupItem key={u.id} value={u.id} className="px-1 text-small" title={u.hint}>
            {u.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <p className="flex min-h-4 items-center gap-1.5 text-[12px] text-studio-muted" role="status">
        {busy && <Loader2 aria-hidden className="size-3 motion-safe:animate-spin" />}
        {busy ? 'Finding straight lines…' : note ?? ''}
      </p>
      <Check
        checked={!!t.constrain}
        onChange={(on) => onUpdate((p) => ({ ...p, transform: { ...p.transform, constrain: on } }), null)}
        hint="Zoom in just enough that no blank edges show"
      >
        Constrain crop
      </Check>
      <SubHead>Manual</SubHead>
      {['transform.vertical', 'transform.horizontal', 'transform.rotate', 'transform.aspect', 'transform.scale', 'transform.offsetX', 'transform.offsetY'].map(s)}
    </div>
  )
}
