import { Crop as CropIcon, FlipHorizontal2, FlipVertical2, Loader2, Ruler, RotateCcw, RotateCcwSquare, RotateCwSquare, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/studio/chip'
import { ASPECTS, aspectRatio, cropForAspect, reshapeCrop } from '@/lib/photo/geometry'
import type { DevelopParams } from '@/lib/photo/types'
import { CROP_OVERLAYS, type CropOverlayKind } from '@/lib/photo/cropOverlays'
import { SELECT } from './DevelopTools'
import { DevelopSlider } from './DevelopSlider'

export interface CropUi {
  aspect: string
  portrait: boolean
  custom: [number, number]
  overlay: CropOverlayKind
  orient: number
  opacity: number
  straightening: boolean
}

interface Props {
  params: DevelopParams
  src: { w: number; h: number } | null
  cropping: boolean
  onCropping: (on: boolean) => void
  ui: CropUi
  onUi: (patch: Partial<CropUi>) => void
  onChange: (fn: (p: DevelopParams) => DevelopParams, group: string | null) => void
  // Auto straighten: the level angle measured on the picture
  onAutoStraighten?: () => void
  straightenBusy?: boolean
}

const STRAIGHTEN = { min: -45, max: 45, step: 0.1, default: 0, label: 'Angle' }
const OPACITY = { min: 0, max: 100, step: 1, default: 60, label: 'Crop opacity' }

const wrap = (deg: number) => {
  const d = ((((deg + 180) % 360) + 360) % 360) - 180
  return Math.round(d * 10) / 10
}

const NUM = 'h-7 w-14 rounded-[6px] border border-studio-border-strong bg-studio-raised px-1.5 text-right font-mono text-small tabular-nums'

/** Crop & straighten: aspect presets (X turns them), a custom ratio, angle with Auto and the straighten tool,
 *  overlays (O / Shift+O), constrain to picture, crop opacity, quarter turns and flips. */
export function GeometryControls({ params, src, cropping, onCropping, ui, onUi, onChange, onAutoStraighten, straightenBusy }: Props) {
  const rot = params.rotate ?? 0
  const quarters = Math.round(rot / 90)
  const rest = Math.round((rot - quarters * 90) * 10) / 10

  const applyAspect = (patch: Partial<CropUi>) => {
    const next = { ...ui, ...patch }
    onUi(patch)
    const r = aspectRatio(next.aspect, src, next.portrait, next.custom)
    if (!src || r == null) return
    // a fresh choice starts from the biggest crop; turning it (X) keeps the area where it is
    onChange((p) => ({ ...p, crop: p.crop && patch.aspect === undefined ? reshapeCrop(p.crop, r, src.w, src.h) : cropForAspect(src.w, src.h, r) }), null)
    onCropping(true)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant={cropping ? 'primary' : 'secondary'} aria-pressed={cropping} onClick={() => onCropping(!cropping)} disabled={!src}>
          <CropIcon aria-hidden />
          {cropping ? 'Done cropping' : 'Crop'}
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Turn left 90°" title="Turn left 90°" onClick={() => onChange((p) => ({ ...p, rotate: wrap(rot - 90) }), null)}>
          <RotateCcwSquare aria-hidden />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Turn right 90°" title="Turn right 90°" onClick={() => onChange((p) => ({ ...p, rotate: wrap(rot + 90) }), null)}>
          <RotateCwSquare aria-hidden />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Flip horizontally" aria-pressed={!!params.flipH} title="Flip horizontally" onClick={() => onChange((p) => ({ ...p, flipH: !p.flipH }), null)}>
          <FlipHorizontal2 aria-hidden />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Flip vertically" aria-pressed={!!params.flipV} title="Flip vertically" onClick={() => onChange((p) => ({ ...p, flipV: !p.flipV }), null)}>
          <FlipVertical2 aria-hidden />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Reset crop and rotation"
          title="Reset crop and rotation"
          onClick={() => onChange((p) => ({ ...p, crop: null, rotate: 0, flipH: false, flipV: false }), null)}
        >
          <RotateCcw aria-hidden />
        </Button>
      </div>
      <div role="group" aria-label="Crop aspect" className="flex flex-wrap gap-1">
        {ASPECTS.map((a) => (
          <Chip key={a.id} selected={ui.aspect === a.id} onClick={() => applyAspect({ aspect: a.id })} className="h-7 px-2 text-small">
            {a.label}
          </Chip>
        ))}
        <Chip selected={ui.portrait} onClick={() => applyAspect({ portrait: !ui.portrait })} className="h-7 px-2 text-small" title="Swap orientation (X)">
          {ui.portrait ? 'Portrait' : 'Landscape'}
        </Chip>
      </div>
      {ui.aspect === 'custom' && (
        <div className="flex items-center gap-2 text-small text-studio-muted">
          <span>Ratio</span>
          <input
            aria-label="Custom ratio width"
            className={NUM}
            inputMode="decimal"
            defaultValue={ui.custom[0]}
            onBlur={(e) => {
              const n = Number(e.target.value.replace(',', '.'))
              if (n > 0 && n <= 100) applyAspect({ custom: [n, ui.custom[1]] })
            }}
          />
          <span aria-hidden>×</span>
          <input
            aria-label="Custom ratio height"
            className={NUM}
            inputMode="decimal"
            defaultValue={ui.custom[1]}
            onBlur={(e) => {
              const n = Number(e.target.value.replace(',', '.'))
              if (n > 0 && n <= 100) applyAspect({ custom: [ui.custom[0], n] })
            }}
          />
        </div>
      )}
      <DevelopSlider
        name="rotate"
        label="Angle"
        value={rest}
        range={STRAIGHTEN}
        onChange={(v, g) => onChange((p) => ({ ...p, rotate: wrap(quarters * 90 + v) }), g)}
      />
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="secondary" onClick={onAutoStraighten} disabled={!onAutoStraighten || straightenBusy} title="Level the horizon from the picture's own lines">
          {straightenBusy ? <Loader2 aria-hidden className="motion-safe:animate-spin" /> : <Wand2 aria-hidden />}
          Auto
        </Button>
        <Button
          size="sm"
          variant={ui.straightening ? 'primary' : 'secondary'}
          aria-pressed={ui.straightening}
          disabled={!src}
          onClick={() => {
            onUi({ straightening: !ui.straightening })
            if (!ui.straightening) onCropping(true)
          }}
          title="Straighten tool: drag along a line that should be level"
        >
          <Ruler aria-hidden />
          Straighten tool
        </Button>
      </div>
      {quarters !== 0 && <p className="text-small text-studio-muted">Turned {quarters * 90 > 0 ? 'right' : 'left'} {Math.abs(quarters * 90)}°</p>}
      <label className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-small text-studio-muted">Overlay</span>
        <select className={SELECT} value={ui.overlay} onChange={(e) => onUi({ overlay: e.target.value as CropOverlayKind })} title="O cycles, Shift+O turns it">
          {CROP_OVERLAYS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-2 text-small text-studio-text" title="Keep blank edges from lens and transform warps out of the crop">
        <input
          type="checkbox"
          className="size-4 accent-studio-accent"
          checked={!!params.transform?.constrain}
          onChange={(e) => {
            const on = e.target.checked
            onChange((p) => ({ ...p, transform: { ...p.transform, constrain: on } }), null)
          }}
        />
        Constrain to image
      </label>
      <DevelopSlider name="cropOpacity" label="Crop opacity" value={Math.round(ui.opacity * 100)} range={OPACITY} onChange={(v) => onUi({ opacity: v / 100 })} />
    </div>
  )
}
