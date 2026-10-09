import { Crop as CropIcon, FlipHorizontal2, FlipVertical2, RotateCcw, RotateCcwSquare, RotateCwSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/studio/chip'
import { ASPECTS, cropForAspect } from '@/lib/photo/geometry'
import type { DevelopParams } from '@/lib/photo/types'
import { DevelopSlider } from './DevelopSlider'

interface Props {
  params: DevelopParams
  src: { w: number; h: number } | null
  cropping: boolean
  onCropping: (on: boolean) => void
  aspect: string
  onAspect: (id: string) => void
  onChange: (fn: (p: DevelopParams) => DevelopParams, group: string | null) => void
}

const STRAIGHTEN = { min: -45, max: 45, step: 0.1, default: 0, label: 'Straighten' }

const wrap = (deg: number) => {
  const d = ((((deg + 180) % 360) + 360) % 360) - 180
  return Math.round(d * 10) / 10
}

/** Crop & rotate: aspect presets, quarter turns, straighten, flips. */
export function GeometryControls({ params, src, cropping, onCropping, aspect, onAspect, onChange }: Props) {
  const rot = params.rotate ?? 0
  const quarters = Math.round(rot / 90)
  const rest = Math.round((rot - quarters * 90) * 10) / 10

  const pickAspect = (id: string) => {
    onAspect(id)
    const a = ASPECTS.find((x) => x.id === id)
    if (!src || !a || a.ratio == null) return
    onChange((p) => ({ ...p, crop: cropForAspect(src.w, src.h, a.ratio!) }), null)
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
          <Chip key={a.id} selected={aspect === a.id} onClick={() => pickAspect(a.id)} className="h-7 px-2 text-small">
            {a.label}
          </Chip>
        ))}
      </div>
      <DevelopSlider
        name="rotate"
        label="Straighten"
        value={rest}
        range={STRAIGHTEN}
        onChange={(v, g) => onChange((p) => ({ ...p, rotate: wrap(quarters * 90 + v) }), g)}
      />
      {quarters !== 0 && <p className="text-small text-studio-muted">Turned {quarters * 90 > 0 ? 'right' : 'left'} {Math.abs(quarters * 90)}°</p>}
    </div>
  )
}
